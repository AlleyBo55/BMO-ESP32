import 'server-only';

import { embed } from '@/lib/openrouter';
import {
  BRAIN_EMBEDDING_DIMENSIONS,
  BRAIN_EMBEDDING_MODEL,
  brainWarn,
  type ScoredMemory,
} from '@/lib/brain/contracts';
import { getServiceClient } from '@/lib/supabase-admin';

/**
 * Hybrid retrieval for the BMO brain core — vector + keyword + RRF.
 *
 * The real gbrain (https://github.com/garrytan/gbrain) does not rely on a
 * single retriever, and neither should we: semantic (vector) similarity and
 * lexical (full-text/BM25-style) search have complementary blind spots.
 * Vectors capture meaning but can miss exact tokens — a rare proper noun, an
 * id, an uncommon word phrased differently than at capture time. Keyword
 * search nails those exact hits but is deaf to paraphrase. Running both and
 * fusing the results recovers what either alone would drop.
 *
 * Fusion uses Reciprocal Rank Fusion (RRF), the standard rank-only combiner:
 *
 *     rrfScore(doc) = sum over each result list of  1 / (k + rank_position)
 *
 * with rank_position 1-based and k = 60 (the value from the original RRF
 * paper). RRF works on *positions*, not raw scores, so it sidesteps the
 * hard problem of normalizing a cosine similarity (0..1) against a ts_rank
 * (unbounded, corpus-dependent) onto a common scale. A document near the top
 * of either list scores well; a document near the top of *both* scores best.
 *
 * Graceful degradation is non-negotiable (see lib/brain.ts): retrieval is an
 * enhancement, never a hard dependency. Every failure path resolves to a
 * partial or empty result and logs via {@link brainWarn} rather than
 * throwing. If embedding fails we fall back to keyword-only; if keyword
 * search fails we fall back to vector-only; if both fail we return [].
 *
 * Backed by:
 *   - `match_brain_memory`    (0003_brain_memory.sql) — vector channel.
 *   - `keyword_search_memory` (0008_brain_search.sql) — lexical channel.
 */

/** RRF damping constant; 60 is the value from the original Cormack et al. paper. */
const RRF_K = 60;

/** Default number of fused hits returned to the caller. */
const DEFAULT_LIMIT = 8;

/**
 * How many rows to pull from each underlying channel before fusion. Kept a
 * touch wider than the default output so fusion has room to reorder before
 * the final truncation.
 */
const CHANNEL_FETCH_COUNT = 20;

/**
 * One fused search result. Carries the 1-based position the row held in each
 * underlying channel (`null` when that channel did not return it) alongside
 * the combined RRF score used for the final ordering.
 */
export interface HybridHit {
  id: string;
  kind: string;
  content: string;
  createdAt: string;
  /** 1-based position in the vector list, or null if absent there. */
  vectorRank: number | null;
  /** 1-based position in the keyword list, or null if absent there. */
  keywordRank: number | null;
  /** Fused Reciprocal Rank Fusion score; higher is more relevant. */
  rrfScore: number;
}

/** Minimal shape every channel produces before fusion. */
interface ChannelRow {
  id: string;
  kind: string;
  content: string;
  createdAt: string;
}

/**
 * Embeds `query` and returns the vector channel's ranked rows, best first.
 * Returns null (not []) to signal the channel was unavailable — embedding
 * failure or RPC error — so the caller can distinguish "no hits" from
 * "channel down" and fall back accordingly.
 */
async function vectorChannel(
  query: string,
  signal: AbortSignal | undefined,
): Promise<ChannelRow[] | null> {
  let embedding: number[];
  try {
    const res = await embed({
      model: BRAIN_EMBEDDING_MODEL,
      input: query,
      dimensions: BRAIN_EMBEDDING_DIMENSIONS,
      signal,
    });
    const vec = res.embeddings[0];
    if (vec === undefined || vec.length === 0) {
      brainWarn('search:vector', 'embedding response was empty');
      return null;
    }
    embedding = vec;
  } catch (err) {
    brainWarn('search:vector', err);
    return null;
  }

  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase.rpc('match_brain_memory', {
      query_embedding: embedding,
      match_count: CHANNEL_FETCH_COUNT,
      min_similarity: 0,
    });
    if (error !== null) {
      brainWarn('search:vector', error.message);
      return null;
    }
    return toChannelRows(data);
  } catch (err) {
    brainWarn('search:vector', err);
    return null;
  }
}

/**
 * Runs the lexical channel via `keyword_search_memory` and returns its ranked
 * rows, best first. Returns null when the channel is unavailable (RPC error)
 * so the caller can fall back to vector-only.
 */
async function keywordChannel(
  query: string,
  signal: AbortSignal | undefined,
): Promise<ChannelRow[] | null> {
  try {
    const supabase = getServiceClient();
    const builder = supabase.rpc('keyword_search_memory', {
      query_text: query,
      match_count: CHANNEL_FETCH_COUNT,
    });
    // The supabase-js builder honors an AbortSignal when one is supplied.
    const { data, error } = await (signal !== undefined
      ? builder.abortSignal(signal)
      : builder);
    if (error !== null) {
      brainWarn('search:keyword', error.message);
      return null;
    }
    return toChannelRows(data);
  } catch (err) {
    brainWarn('search:keyword', err);
    return null;
  }
}

/**
 * Narrows an untyped RPC payload into ChannelRow[], dropping any row missing
 * the id/content it needs. Tolerant by design: a malformed row is skipped,
 * never fatal.
 */
function toChannelRows(data: unknown): ChannelRow[] {
  if (!Array.isArray(data)) return [];
  const rows: ChannelRow[] = [];
  for (const row of data) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.content !== 'string') continue;
    rows.push({
      id: r.id,
      kind: typeof r.kind === 'string' ? r.kind : 'conversation',
      content: r.content,
      createdAt: typeof r.created_at === 'string' ? r.created_at : '',
    });
  }
  return rows;
}

/**
 * Fuses the two ranked channels with Reciprocal Rank Fusion and returns the
 * merged hits sorted by descending RRF score. Each input list is assumed to
 * already be ordered best-first; positions are derived from array index.
 */
function fuse(
  vectorRows: ChannelRow[],
  keywordRows: ChannelRow[],
): HybridHit[] {
  const merged = new Map<string, HybridHit>();

  const ensure = (row: ChannelRow): HybridHit => {
    const existing = merged.get(row.id);
    if (existing !== undefined) return existing;
    const created: HybridHit = {
      id: row.id,
      kind: row.kind,
      content: row.content,
      createdAt: row.createdAt,
      vectorRank: null,
      keywordRank: null,
      rrfScore: 0,
    };
    merged.set(row.id, created);
    return created;
  };

  vectorRows.forEach((row, index) => {
    const position = index + 1; // 1-based rank position.
    const hit = ensure(row);
    hit.vectorRank = position;
    hit.rrfScore += 1 / (RRF_K + position);
  });

  keywordRows.forEach((row, index) => {
    const position = index + 1; // 1-based rank position.
    const hit = ensure(row);
    hit.keywordRank = position;
    hit.rrfScore += 1 / (RRF_K + position);
  });

  return Array.from(merged.values()).sort((a, b) => b.rrfScore - a.rrfScore);
}

/**
 * Hybrid recall: searches `brain_memory` over both the vector and keyword
 * channels and fuses the results with Reciprocal Rank Fusion.
 *
 * Always resolves — never throws. Degrades channel-by-channel:
 *   - embedding/vector channel down → keyword-only results,
 *   - keyword channel down          → vector-only results,
 *   - both down (or blank query)    → [].
 *
 * @param query  Free-text query. Blank queries return [] immediately.
 * @param limit  Max fused hits to return. Defaults to 8.
 * @param signal Optional abort signal forwarded to both channels.
 * @returns Up to `limit` {@link HybridHit}s, best (highest RRF) first.
 */
export async function hybridSearch(
  query: string,
  limit: number = DEFAULT_LIMIT,
  signal?: AbortSignal,
): Promise<HybridHit[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  // Run both channels concurrently; each resolves to null when unavailable.
  const [vectorRows, keywordRows] = await Promise.all([
    vectorChannel(trimmed, signal),
    keywordChannel(trimmed, signal),
  ]);

  if (vectorRows === null && keywordRows === null) {
    // Both channels failed — nothing to fuse.
    return [];
  }

  const fused = fuse(vectorRows ?? [], keywordRows ?? []);
  const top = limit > 0 ? limit : DEFAULT_LIMIT;
  return fused.slice(0, top);
}

/**
 * Adapts {@link HybridHit}s to the shared {@link ScoredMemory} contract used
 * across the brain core, exposing the fused RRF score as `similarity`. Handy
 * when a caller wants hybrid retrieval but consumes the common memory shape.
 */
export function toScoredMemories(hits: HybridHit[]): ScoredMemory[] {
  return hits.map((hit): ScoredMemory => ({
    id: hit.id,
    kind: hit.kind === 'fact' || hit.kind === 'note' ? hit.kind : 'conversation',
    content: hit.content,
    createdAt: hit.createdAt,
    similarity: hit.rrfScore,
  }));
}
