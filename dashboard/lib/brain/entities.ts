import 'server-only';

import { chat } from '@/lib/openrouter';
import { BRAIN_REASONING_MODEL, brainWarn } from '@/lib/brain/contracts';
import { getServiceClient } from '@/lib/supabase-admin';

/**
 * entities — the WRITE path of gbrain's self-wiring knowledge graph.
 *
 * The real gbrain (github.com/garrytan/gbrain) is famous for a brain that
 * *wires itself*: as memories land, it pulls out the people, places, things,
 * activities and concepts they mention and links them up, so that later a
 * single concept ("Nenek", "sekolah", "dinosaurus") can fan out to every
 * memory that touches it. That graph is what turns a flat pile of memories
 * into something you can reason over.
 *
 * BMO reproduces that idea on the stack it already has. This module owns the
 * write half of the graph:
 *
 *   1. {@link extractEntities} — ask the cheap reasoning LLM to read a
 *      memory's text and name the entities in it as strict JSON.
 *   2. {@link autoLinkMemory} — find-or-create each entity in
 *      `brain_entities`, then connect the memory to it via the
 *      `brain_memory_entities` join table, returning how many edges were
 *      added.
 *
 * These tables are created by a sibling migration (0004_brain_graph.sql):
 *
 *   - brain_entities(id uuid pk, name text, type text, created_at timestamptz)
 *   - brain_memory_entities(id uuid pk, memory_id uuid, entity_id uuid,
 *                           created_at timestamptz)
 *
 * --------------------------------------------------------------------------
 * Graceful degradation (load-bearing rule).
 * --------------------------------------------------------------------------
 * The graph is an ENHANCEMENT, never a hard dependency, exactly like the
 * memory layer in `lib/brain.ts`. The migration may not have run yet, the
 * LLM call may fail, the JSON may be garbage — in every one of those cases
 * the functions here resolve to a safe empty/0 value and log via
 * {@link brainWarn}. Nothing on the brain path ever throws because entity
 * extraction or linking failed. Capture keeps working with zero edges; the
 * graph simply fills in once the table exists and the model cooperates.
 */

/** Coarse class of a graph node. Mirrors the `type` column on brain_entities. */
export type EntityType = 'person' | 'place' | 'thing' | 'activity' | 'concept';

/** A single entity pulled out of a memory's text. `name` is display-cased. */
export interface ExtractedEntity {
  name: string;
  type: EntityType;
}

/** Upper bound on entities per memory — keeps the graph (and cost) sane. */
const MAX_ENTITIES = 12;

/** The set of accepted entity types, used to validate model output. */
const ENTITY_TYPES: readonly EntityType[] = [
  'person',
  'place',
  'thing',
  'activity',
  'concept',
];

/**
 * The extraction prompt. Deliberately terse: we want a cheap, fast call that
 * returns nothing but a JSON array. Indonesian context (BMO talks to a child
 * in Indonesian) is hinted so the model keeps proper nouns intact.
 */
const EXTRACTION_SYSTEM_PROMPT = [
  'You extract knowledge-graph entities from a short memory text.',
  'The text is usually Indonesian, from a conversation between a child and a toy named BMO.',
  'Return ONLY a strict JSON array (no prose, no markdown fences) of objects',
  'with exactly these keys: "name" (string) and "type" (one of:',
  '"person", "place", "thing", "activity", "concept").',
  'Use the entity name as it appears in the text. Do not invent entities.',
  'Skip BMO itself and generic filler. Return at most 12 of the most salient',
  'entities. If there are none, return [].',
].join(' ');

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isEntityType(v: unknown): v is EntityType {
  return typeof v === 'string' && (ENTITY_TYPES as readonly string[]).includes(v);
}

/**
 * Collapses internal whitespace and trims. Returns the display form; matching
 * is done separately on the lowercased version so we keep readable casing
 * (e.g. "Nenek") while still de-duplicating "nenek" / "Nenek".
 */
function normalizeName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * Pulls the first top-level JSON array out of a model response. Models
 * sometimes wrap output in ```json fences or add a stray sentence; we slice
 * from the first `[` to the last `]` so defensive parsing still succeeds.
 * Returns null when no array-shaped span exists.
 */
function extractJsonArray(text: string): string | null {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

/**
 * Asks the reasoning LLM to name the entities in `text`. Always resolves: on
 * any failure (LLM error, non-JSON, wrong shape) it returns `[]` so the
 * caller can proceed without graph enrichment.
 *
 * Output is normalized (trimmed, whitespace-collapsed), de-duplicated by
 * lowercased name, and capped at {@link MAX_ENTITIES}.
 */
export async function extractEntities(
  text: string,
  signal?: AbortSignal,
): Promise<ExtractedEntity[]> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  let raw: string;
  try {
    const res = await chat({
      model: BRAIN_REASONING_MODEL,
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: trimmed }],
      signal,
    });
    raw = res.text;
  } catch (err) {
    brainWarn('entities.extract', err);
    return [];
  }

  const jsonSpan = extractJsonArray(raw);
  if (jsonSpan === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSpan);
  } catch (err) {
    brainWarn('entities.extract', err);
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: ExtractedEntity[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    if (typeof item.name !== 'string') continue;
    if (!isEntityType(item.type)) continue;
    const name = normalizeName(item.name);
    if (name.length === 0) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, type: item.type });
    if (out.length >= MAX_ENTITIES) break;
  }
  return out;
}

/**
 * Finds an existing entity by its lowercased name or creates it, returning
 * the entity id. Returns null on any failure (e.g. missing table) so the
 * caller can skip this edge without aborting the whole link pass.
 */
async function findOrCreateEntity(
  supabase: ReturnType<typeof getServiceClient>,
  entity: ExtractedEntity,
): Promise<string | null> {
  const matchName = entity.name.toLowerCase();
  try {
    // Find-or-create keyed on the lowercased name so "Nenek" and "nenek"
    // resolve to one node. We store the lowercased form in `name`; the
    // display casing lives with the memory text.
    const existing = await supabase
      .from('brain_entities')
      .select('id')
      .eq('name', matchName)
      .limit(1)
      .maybeSingle();
    if (existing.error !== null) {
      brainWarn('entities.find', existing.error.message);
      return null;
    }
    if (isRecord(existing.data) && typeof existing.data.id === 'string') {
      return existing.data.id;
    }

    const created = await supabase
      .from('brain_entities')
      .insert({ name: matchName, type: entity.type })
      .select('id')
      .single();
    if (created.error !== null) {
      brainWarn('entities.create', created.error.message);
      return null;
    }
    if (isRecord(created.data) && typeof created.data.id === 'string') {
      return created.data.id;
    }
    return null;
  } catch (err) {
    brainWarn('entities.findOrCreate', err);
    return null;
  }
}

/**
 * Links `memoryId` to `entityId` via the join table unless that edge already
 * exists. Returns true when a new edge row was inserted, false otherwise
 * (already linked, or any failure). Keeps {@link autoLinkMemory} idempotent.
 */
async function linkMemoryToEntity(
  supabase: ReturnType<typeof getServiceClient>,
  memoryId: string,
  entityId: string,
): Promise<boolean> {
  try {
    const existing = await supabase
      .from('brain_memory_entities')
      .select('id')
      .eq('memory_id', memoryId)
      .eq('entity_id', entityId)
      .limit(1)
      .maybeSingle();
    if (existing.error !== null) {
      brainWarn('entities.linkCheck', existing.error.message);
      return false;
    }
    if (isRecord(existing.data) && typeof existing.data.id === 'string') {
      // Edge already present — idempotent no-op.
      return false;
    }

    const inserted = await supabase
      .from('brain_memory_entities')
      .insert({ memory_id: memoryId, entity_id: entityId });
    if (inserted.error !== null) {
      brainWarn('entities.link', inserted.error.message);
      return false;
    }
    return true;
  } catch (err) {
    brainWarn('entities.link', err);
    return false;
  }
}

/**
 * Extracts the entities in `content`, ensures each exists in `brain_entities`,
 * and connects `memoryId` to them in `brain_memory_entities`. Returns the
 * number of NEW edges created (0 when there is nothing to link, the table is
 * missing, or every edge already existed).
 *
 * Always resolves — never throws — so it is safe to fire-and-forget right
 * after `capture()` on the brain path. Idempotent-ish: re-running it for the
 * same memory will not duplicate join rows.
 */
export async function autoLinkMemory(
  memoryId: string,
  content: string,
  signal?: AbortSignal,
): Promise<number> {
  if (memoryId.length === 0) return 0;

  const entities = await extractEntities(content, signal);
  if (entities.length === 0) return 0;

  let edges = 0;
  try {
    const supabase = getServiceClient();
    for (const entity of entities) {
      const entityId = await findOrCreateEntity(supabase, entity);
      if (entityId === null) continue;
      const linked = await linkMemoryToEntity(supabase, memoryId, entityId);
      if (linked) edges += 1;
    }
  } catch (err) {
    brainWarn('entities.autoLink', err);
    return edges;
  }
  return edges;
}
