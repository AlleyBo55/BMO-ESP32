import 'server-only';

import { getServiceClient } from '@/lib/supabase-admin';
import { brainWarn, type MemoryKind, type MemoryRow } from '@/lib/brain/contracts';

/**
 * graph.ts — BMO's self-wiring knowledge graph (the "gbrain" graph layer).
 *
 * The real gbrain (https://github.com/garrytan/gbrain) is famous for one
 * trick above all: it doesn't just store memories, it *wires them together*.
 * As it learns, it pulls entities out of what it's told and connects them
 * into a graph, so recall stops being "find similar text" and becomes "walk
 * the map of what I know". This module reproduces that idea on the three
 * tables added in 0004_brain_graph.sql:
 *
 *   * brain_entities         — nodes, deduped by a lowercased `name_key`.
 *   * brain_edges            — typed, directed connections between nodes.
 *   * brain_memory_entities  — join: which memory mentions which node.
 *
 * The "self-wiring" part lives in the calling layer (the sibling entities.ts
 * extracts entities from each captured memory and calls {@link upsertEntity}
 * / {@link addEdge} here). This module owns the graph primitives:
 *
 *   * upsertEntity()    — find-or-create a node by its lowercased name.
 *   * addEdge()         — connect two nodes with a typed, idempotent edge.
 *   * neighbors()       — multi-hop BFS outward from a node.
 *   * relatedMemories() — every memory that ever mentioned a node.
 *
 * --------------------------------------------------------------------------
 * Graceful degradation (important).
 * --------------------------------------------------------------------------
 * The graph is an ENHANCEMENT, never a hard dependency. Every function here
 * is wrapped so that a missing table, an RLS surprise, or any client error
 * resolves to a safe empty/null/false value and logs a warning via
 * {@link brainWarn}. Nothing in this file ever throws. BMO keeps talking
 * exactly as it did before the graph existed.
 */

/** A single graph node as exposed to callers. */
export interface GraphEntity {
  id: string;
  name: string;
  type: string;
}

/** Allowed entity types, mirrors the CHECK constraint in 0004_brain_graph.sql. */
const ENTITY_TYPES = ['person', 'place', 'thing', 'activity', 'concept'] as const;
type EntityType = (typeof ENTITY_TYPES)[number];

/** Default + hard cap on how far {@link neighbors} will walk the graph. */
const DEFAULT_NEIGHBOR_DEPTH = 1;
const MAX_NEIGHBOR_DEPTH = 2;

/** Default number of memories {@link relatedMemories} returns. */
const DEFAULT_RELATED_MEMORY_LIMIT = 10;

/**
 * Normalizes a display name into the lowercased match key the graph dedupes
 * on. Collapses internal whitespace and trims so "  Doraemon " and
 * "doraemon" resolve to the same node.
 */
function toNameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Coerces an arbitrary value into a valid entity type, defaulting to concept. */
function normalizeType(type: string | undefined): EntityType {
  if (typeof type !== 'string') return 'concept';
  const lowered = type.trim().toLowerCase();
  return (ENTITY_TYPES as readonly string[]).includes(lowered)
    ? (lowered as EntityType)
    : 'concept';
}

/** Defensively pulls a string id out of an unknown row shape. */
function readId(row: unknown): string | null {
  if (typeof row !== 'object' || row === null) return null;
  const id = (row as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** Parses an unknown row into a GraphEntity, or null when it doesn't fit. */
function toGraphEntity(row: unknown): GraphEntity | null {
  if (typeof row !== 'object' || row === null) return null;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.name !== 'string') return null;
  return {
    id: r.id,
    name: r.name,
    type: typeof r.type === 'string' ? r.type : 'concept',
  };
}

/* -------------------------------------------------------------------------- */
/* upsertEntity — find-or-create a node                                        */
/* -------------------------------------------------------------------------- */

/**
 * Finds an existing entity by its lowercased `name_key`, creating it if it
 * doesn't exist yet, and returns its id. Returns null when `name` is empty
 * or on any failure, so callers can skip wiring rather than crash.
 *
 * Idempotent under concurrent callers: if a parallel insert wins the unique
 * `name_key` race, we fall back to re-selecting the existing row.
 */
export async function upsertEntity(name: string, type?: string): Promise<string | null> {
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  const nameKey = toNameKey(trimmed);
  if (nameKey.length === 0) return null;

  try {
    const supabase = getServiceClient();

    // Fast path: the node already exists.
    const existing = await supabase
      .from('brain_entities')
      .select('id')
      .eq('name_key', nameKey)
      .maybeSingle();
    if (existing.error === null) {
      const id = readId(existing.data);
      if (id !== null) return id;
    }

    // Create it. On a unique-violation race, re-select the winner's row.
    const inserted = await supabase
      .from('brain_entities')
      .insert({ name: trimmed, name_key: nameKey, type: normalizeType(type) })
      .select('id')
      .single();
    if (inserted.error === null) {
      const id = readId(inserted.data);
      if (id !== null) return id;
    } else {
      const reselect = await supabase
        .from('brain_entities')
        .select('id')
        .eq('name_key', nameKey)
        .maybeSingle();
      if (reselect.error === null) {
        const id = readId(reselect.data);
        if (id !== null) return id;
      }
      brainWarn('graph.upsertEntity', inserted.error.message);
    }
    return null;
  } catch (err) {
    brainWarn('graph.upsertEntity', err);
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* addEdge — connect two nodes                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Wires a typed edge from `fromName` to `toName`, upserting both endpoints
 * first. Idempotent: the unique (from_entity, to_entity, type) constraint
 * means re-adding the same relationship is a no-op. Returns true when the
 * edge exists after the call, false on any failure or self-loop.
 */
export async function addEdge(fromName: string, toName: string, type?: string): Promise<boolean> {
  try {
    const fromId = await upsertEntity(fromName);
    const toId = await upsertEntity(toName);
    if (fromId === null || toId === null) return false;
    // A node related to itself carries no information; skip it.
    if (fromId === toId) return false;

    const edgeType = typeof type === 'string' && type.trim().length > 0 ? type.trim() : 'related';

    const supabase = getServiceClient();
    const { error } = await supabase
      .from('brain_edges')
      .upsert(
        { from_entity: fromId, to_entity: toId, type: edgeType },
        { onConflict: 'from_entity,to_entity,type', ignoreDuplicates: true },
      );
    if (error !== null) {
      brainWarn('graph.addEdge', error.message);
      return false;
    }
    return true;
  } catch (err) {
    brainWarn('graph.addEdge', err);
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* neighbors — walk the graph outward                                          */
/* -------------------------------------------------------------------------- */

/**
 * Returns the entities reachable from `entityName` within `depth` hops,
 * deduped and excluding the seed node itself. Edges are treated as
 * undirected for traversal (a connection is a connection regardless of which
 * way it was written). `depth` defaults to 1 and is capped at 2 to keep the
 * fan-out bounded. Returns an empty array on any failure.
 */
export async function neighbors(entityName: string, depth?: number): Promise<GraphEntity[]> {
  const seedKey = toNameKey(entityName);
  if (seedKey.length === 0) return [];

  const requested = typeof depth === 'number' && Number.isFinite(depth) ? Math.floor(depth) : DEFAULT_NEIGHBOR_DEPTH;
  const maxDepth = Math.max(1, Math.min(requested, MAX_NEIGHBOR_DEPTH));

  try {
    const supabase = getServiceClient();

    // Resolve the seed node.
    const seed = await supabase
      .from('brain_entities')
      .select('id')
      .eq('name_key', seedKey)
      .maybeSingle();
    if (seed.error !== null) {
      brainWarn('graph.neighbors', seed.error.message);
      return [];
    }
    const seedId = readId(seed.data);
    if (seedId === null) return [];

    // BFS outward. `visited` holds every id we've already enqueued (seed
    // included) so we never revisit; `frontier` is the current ring.
    const visited = new Set<string>([seedId]);
    const collected = new Set<string>();
    let frontier: string[] = [seedId];

    for (let hop = 0; hop < maxDepth && frontier.length > 0; hop++) {
      const { data, error } = await supabase
        .from('brain_edges')
        .select('from_entity, to_entity')
        .or(`from_entity.in.(${frontier.join(',')}),to_entity.in.(${frontier.join(',')})`);
      if (error !== null) {
        brainWarn('graph.neighbors', error.message);
        break;
      }
      if (!Array.isArray(data)) break;

      const next: string[] = [];
      for (const row of data) {
        if (typeof row !== 'object' || row === null) continue;
        const r = row as Record<string, unknown>;
        for (const key of ['from_entity', 'to_entity'] as const) {
          const id = r[key];
          if (typeof id !== 'string' || id.length === 0) continue;
          if (visited.has(id)) continue;
          visited.add(id);
          collected.add(id);
          next.push(id);
        }
      }
      frontier = next;
    }

    if (collected.size === 0) return [];

    // Hydrate the collected ids into full nodes.
    const { data, error } = await supabase
      .from('brain_entities')
      .select('id, name, type')
      .in('id', Array.from(collected));
    if (error !== null) {
      brainWarn('graph.neighbors', error.message);
      return [];
    }
    if (!Array.isArray(data)) return [];

    return data
      .map((row): GraphEntity | null => toGraphEntity(row))
      .filter((e): e is GraphEntity => e !== null);
  } catch (err) {
    brainWarn('graph.neighbors', err);
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* relatedMemories — memories that mention a node                              */
/* -------------------------------------------------------------------------- */

/**
 * Returns the memories that mention `entityName`, newest first. Walks the
 * join table (brain_memory_entities) for the named node, then hydrates the
 * referenced brain_memory rows. `limit` defaults to 10. Returns an empty
 * array on any failure.
 */
export async function relatedMemories(entityName: string, limit?: number): Promise<MemoryRow[]> {
  const nameKey = toNameKey(entityName);
  if (nameKey.length === 0) return [];

  const max =
    typeof limit === 'number' && Number.isFinite(limit) && limit > 0
      ? Math.floor(limit)
      : DEFAULT_RELATED_MEMORY_LIMIT;

  try {
    const supabase = getServiceClient();

    // Resolve the node.
    const entity = await supabase
      .from('brain_entities')
      .select('id')
      .eq('name_key', nameKey)
      .maybeSingle();
    if (entity.error !== null) {
      brainWarn('graph.relatedMemories', entity.error.message);
      return [];
    }
    const entityId = readId(entity.data);
    if (entityId === null) return [];

    // Pull the linked memory rows through the join table, newest first.
    // Over-fetch links a little so we can sort the hydrated rows by their
    // own created_at and still honour `limit`.
    const links = await supabase
      .from('brain_memory_entities')
      .select('memory_id')
      .eq('entity_id', entityId);
    if (links.error !== null) {
      brainWarn('graph.relatedMemories', links.error.message);
      return [];
    }
    if (!Array.isArray(links.data)) return [];

    const memoryIds: string[] = [];
    const seen = new Set<string>();
    for (const row of links.data) {
      if (typeof row !== 'object' || row === null) continue;
      const id = (row as { memory_id?: unknown }).memory_id;
      if (typeof id !== 'string' || id.length === 0) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      memoryIds.push(id);
    }
    if (memoryIds.length === 0) return [];

    const { data, error } = await supabase
      .from('brain_memory')
      .select('id, kind, content, created_at')
      .in('id', memoryIds)
      .order('created_at', { ascending: false })
      .limit(max);
    if (error !== null) {
      brainWarn('graph.relatedMemories', error.message);
      return [];
    }
    if (!Array.isArray(data)) return [];

    return data
      .map((row): MemoryRow | null => {
        if (typeof row !== 'object' || row === null) return null;
        const r = row as Record<string, unknown>;
        if (typeof r.id !== 'string' || typeof r.content !== 'string') return null;
        const kind: MemoryKind = r.kind === 'fact' || r.kind === 'note' ? r.kind : 'conversation';
        return {
          id: r.id,
          kind,
          content: r.content,
          createdAt: typeof r.created_at === 'string' ? r.created_at : '',
        };
      })
      .filter((m): m is MemoryRow => m !== null);
  } catch (err) {
    brainWarn('graph.relatedMemories', err);
    return [];
  }
}
