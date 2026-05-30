import 'server-only';

import { chat } from '@/lib/openrouter';
import { BRAIN_REASONING_MODEL, brainWarn } from '@/lib/brain/contracts';
import { getServiceClient } from '@/lib/supabase-admin';

/**
 * Salience + dedup — the consolidation half of BMO's gbrain layer.
 *
 * Two responsibilities, both modelled on gbrain's "dream cycle" idea that a
 * brain should curate itself rather than hoard everything equally:
 *
 *   1. Salience scoring — an LLM rates how worth-remembering a memory is for
 *      a child's companion toy (a pet's name vs. throwaway small-talk). The
 *      score (0..1) plus access bookkeeping lets future consolidation boost,
 *      decay, or prune rows on principled grounds.
 *
 *   2. Deduplication — auto-growing memory drifts toward near-duplicates;
 *      {@link findDuplicates} groups them so a caller can collapse each
 *      cluster down to its canonical (oldest) row.
 *
 * Degradation discipline (same as the rest of lib/brain): every function here
 * resolves to a safe default and logs via {@link brainWarn} on any failure —
 * missing column, missing RPC, LLM error. Salience is an enhancement, never a
 * hard dependency, so it must never throw onto the brain path.
 */

/** Neutral fallback salience when scoring cannot be completed. */
const DEFAULT_SALIENCE = 0.5;

/** Default cosine-similarity floor for treating two memories as duplicates. */
const DEFAULT_DUPLICATE_THRESHOLD = 0.95;

/** System prompt for the salience rater. Keeps the model terse and numeric. */
const SALIENCE_SYSTEM_PROMPT = [
  'You score how important and memorable a piece of text is for a small',
  "companion toy to remember about the child it talks to, long-term.",
  'High scores (near 1.0): names, relationships, pets, fears, preferences,',
  'recurring routines, meaningful events — things worth recalling weeks later.',
  'Low scores (near 0.0): filler chit-chat, greetings, one-off noise with no',
  'lasting value.',
  'Reply with ONLY a single decimal number between 0 and 1 (e.g. 0.82).',
  'No words, no explanation, no extra characters.',
].join(' ');

/** A cluster of duplicate memories: keep one canonical row, drop the rest. */
export interface DuplicateGroup {
  keep: string;
  drop: string[];
}

/** Clamps a number into the inclusive 0..1 range. */
function clamp01(value: number): number {
  if (Number.isNaN(value)) return DEFAULT_SALIENCE;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Extracts the first 0..1 decimal from arbitrary model output. Returns null
 * when no parseable number is present so the caller can fall back.
 */
function parseSalience(text: string): number | null {
  const match = text.match(/-?\d*\.?\d+/);
  if (match === null) return null;
  const parsed = Number.parseFloat(match[0]);
  if (Number.isNaN(parsed)) return null;
  return clamp01(parsed);
}

/**
 * Rates how important/memorable `content` is for BMO to remember long-term,
 * on a 0..1 scale, using the brain reasoning model. Always resolves: on empty
 * input, an LLM error, or an unparseable reply it returns {@link
 * DEFAULT_SALIENCE} (0.5) and logs a warning.
 */
export async function scoreSalience(content: string, signal?: AbortSignal): Promise<number> {
  const trimmed = content.trim();
  if (trimmed.length === 0) return DEFAULT_SALIENCE;

  try {
    const res = await chat({
      model: BRAIN_REASONING_MODEL,
      systemPrompt: SALIENCE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: trimmed }],
      signal,
    });
    const score = parseSalience(res.text);
    if (score === null) {
      brainWarn('salience', `unparseable salience reply: "${res.text.slice(0, 80)}"`);
      return DEFAULT_SALIENCE;
    }
    return score;
  } catch (err) {
    brainWarn('salience', err);
    return DEFAULT_SALIENCE;
  }
}

/**
 * Persists a salience score onto a memory row, clamping it into 0..1 first.
 * Fire-and-forget safe: always resolves, never throws. A missing column or
 * RPC simply logs a warning.
 */
export async function persistSalience(memoryId: string, salience: number): Promise<void> {
  const id = memoryId.trim();
  if (id.length === 0) return;
  const clamped = clamp01(salience);

  try {
    const supabase = getServiceClient();
    const { error } = await supabase
      .from('brain_memory')
      .update({ salience: clamped })
      .eq('id', id);
    if (error !== null) {
      brainWarn('salience', error.message);
    }
  } catch (err) {
    brainWarn('salience', err);
  }
}

/**
 * Records that the given memories were just surfaced by recall: stamps
 * `last_accessed_at = now()` and increments `access_count`. No-op on an empty
 * id list. Always resolves; failures degrade to a warning.
 */
export async function markAccessed(ids: string[]): Promise<void> {
  const clean = ids.map((id) => id.trim()).filter((id) => id.length > 0);
  if (clean.length === 0) return;

  try {
    const supabase = getServiceClient();
    // No portable column-to-column increment via the JS client, so read the
    // current counts and write the bumped values back. Best-effort: a missing
    // row or column degrades to a warning.
    const { data, error } = await supabase
      .from('brain_memory')
      .select('id, access_count')
      .in('id', clean);
    if (error !== null) {
      brainWarn('salience', error.message);
      return;
    }
    if (!Array.isArray(data)) return;

    const now = new Date().toISOString();
    await Promise.all(
      data.map((row) => {
        const r = row as { id?: unknown; access_count?: unknown };
        if (typeof r.id !== 'string') return Promise.resolve();
        const current = typeof r.access_count === 'number' ? r.access_count : 0;
        return supabase
          .from('brain_memory')
          .update({ last_accessed_at: now, access_count: current + 1 })
          .eq('id', r.id)
          .then(({ error: updateError }) => {
            if (updateError !== null) {
              brainWarn('salience', updateError.message);
            }
          });
      }),
    );
  } catch (err) {
    brainWarn('salience', err);
  }
}

/**
 * Finds near-duplicate memories via the `find_duplicate_memories` RPC and
 * groups every `drop_id` under its canonical `keep_id`. Always resolves:
 * returns `[]` on any failure (missing RPC, bad rows) and logs a warning.
 */
export async function findDuplicates(threshold?: number): Promise<DuplicateGroup[]> {
  const similarityThreshold = clamp01(threshold ?? DEFAULT_DUPLICATE_THRESHOLD);

  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase.rpc('find_duplicate_memories', {
      similarity_threshold: similarityThreshold,
    });
    if (error !== null) {
      brainWarn('salience', error.message);
      return [];
    }
    if (!Array.isArray(data)) return [];

    const groups = new Map<string, string[]>();
    for (const row of data) {
      if (typeof row !== 'object' || row === null) continue;
      const r = row as Record<string, unknown>;
      if (typeof r.keep_id !== 'string' || typeof r.drop_id !== 'string') continue;
      const existing = groups.get(r.keep_id);
      if (existing === undefined) {
        groups.set(r.keep_id, [r.drop_id]);
      } else if (!existing.includes(r.drop_id)) {
        existing.push(r.drop_id);
      }
    }

    return Array.from(groups.entries()).map(([keep, drop]) => ({ keep, drop }));
  } catch (err) {
    brainWarn('salience', err);
    return [];
  }
}
