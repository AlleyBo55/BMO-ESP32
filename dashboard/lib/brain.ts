import 'server-only';

import { embed, OpenRouterError } from '@/lib/openrouter';
import { getServiceClient } from '@/lib/supabase-admin';

/**
 * BrainService — BMO's persistent, self-growing memory.
 *
 * This is the "gbrain layer" for BMO. The real gbrain
 * (https://github.com/garrytan/gbrain) is Garry Tan's open-source agent
 * brain: a stateful daemon with its own Postgres, a self-wiring knowledge
 * graph, a 24/7 cron "dream cycle", and a 30+ tool MCP server. That daemon
 * cannot run inside Vercel's stateless functions — it needs a persistent
 * host (a VPS). So this module reproduces gbrain's three load-bearing ideas
 * on the stack BMO already has (Supabase pgvector + OpenRouter embeddings):
 *
 *   1. capture()  — every exchange is written to durable memory.
 *   2. recall()   — brain-first lookup: before BMO answers, retrieve what it
 *                   already knows via semantic (vector) similarity search.
 *   3. auto-grow  — the brain gets richer the more BMO is used; no manual
 *                   curation required.
 *
 * gbrain's `think` (synthesis + gap analysis) and `search` (raw retrieval)
 * split maps here onto recall() feeding the LLM as a tool: the LLM does the
 * synthesis, recall() does the retrieval.
 *
 * --------------------------------------------------------------------------
 * Migration path to the real gbrain.
 * --------------------------------------------------------------------------
 * Everything funnels through {@link recall} and {@link capture}. When you
 * stand up a real `gbrain serve --http` on a VPS, set GBRAIN_HTTP_URL +
 * GBRAIN_TOKEN and these two functions call the daemon's MCP endpoint
 * instead of Supabase. The brain route, the firmware, and the wire format
 * never change. The remote branch is stubbed below behind `isRemoteBrain()`
 * so the seam is already in place.
 *
 * --------------------------------------------------------------------------
 * Graceful degradation (important).
 * --------------------------------------------------------------------------
 * The brain is an ENHANCEMENT, never a hard dependency. If embeddings fail,
 * if the table is missing, if the VPS is unreachable — every function here
 * resolves to a safe empty/no-op value and logs a warning. BMO keeps talking
 * exactly as it did before the brain existed. The brain route must never
 * 502 because recall or capture failed.
 */

/** Embedding model + dimensionality. Must match brain_memory.embedding width. */
const EMBEDDING_MODEL = 'openai/text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;

/** Recall defaults: how many memories to pull and the relevance floor. */
const DEFAULT_RECALL_COUNT = 5;
const DEFAULT_MIN_SIMILARITY = 0.3;

/** Don't bother embedding/storing trivially short fragments. */
const MIN_CAPTURE_CHARS = 8;
/** Cap stored content so one runaway turn can't bloat a row. */
const MAX_CAPTURE_CHARS = 8_000;

export type MemoryKind = 'conversation' | 'fact' | 'note' | 'thought';

/** A single recalled memory with its similarity to the query (0..1). */
export interface RecalledMemory {
  id: string;
  kind: MemoryKind;
  content: string;
  createdAt: string;
  similarity: number;
}

export interface RecallOptions {
  /** Max memories to return. Default 5. */
  limit?: number;
  /** Minimum cosine similarity (0..1) to include. Default 0.3. */
  minSimilarity?: number;
  signal?: AbortSignal | undefined;
}

export interface CaptureOptions {
  kind?: MemoryKind;
  signal?: AbortSignal | undefined;
}

/** True when a real gbrain daemon is configured. Reserved for the VPS path. */
function isRemoteBrain(): boolean {
  const url = process.env.GBRAIN_HTTP_URL;
  return typeof url === 'string' && url.length > 0;
}

function warn(scope: string, err: unknown): void {
  const msg =
    err instanceof OpenRouterError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
  console.warn(`[brain:${scope}] degraded (non-fatal): ${msg}`);
}

/**
 * Embeds a single string. Returns null on any failure so callers can degrade.
 */
async function embedOne(text: string, signal?: AbortSignal): Promise<number[] | null> {
  try {
    const res = await embed({
      model: EMBEDDING_MODEL,
      input: text,
      dimensions: EMBEDDING_DIMENSIONS,
      signal,
    });
    const vec = res.embeddings[0];
    if (vec === undefined || vec.length === 0) return null;
    return vec;
  } catch (err) {
    warn('embed', err);
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* recall — brain-first lookup                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Returns the memories most semantically relevant to `query`, best match
 * first. Always resolves: on any failure (embedding error, missing table,
 * RPC error) it returns an empty array and logs a warning, so the caller can
 * proceed without memory rather than failing the request.
 */
export async function recall(
  query: string,
  options: RecallOptions = {},
): Promise<RecalledMemory[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  if (isRemoteBrain()) {
    return recallRemote(trimmed, options);
  }

  const vec = await embedOne(trimmed, options.signal);
  if (vec === null) return [];

  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase.rpc('match_brain_memory', {
      query_embedding: vec,
      match_count: options.limit ?? DEFAULT_RECALL_COUNT,
      min_similarity: options.minSimilarity ?? DEFAULT_MIN_SIMILARITY,
    });
    if (error !== null) {
      warn('recall', error.message);
      return [];
    }
    if (!Array.isArray(data)) return [];
    return data
      .map((row): RecalledMemory | null => {
        if (typeof row !== 'object' || row === null) return null;
        const r = row as Record<string, unknown>;
        if (typeof r.id !== 'string' || typeof r.content !== 'string') return null;
        const kind: MemoryKind =
          r.kind === 'fact' || r.kind === 'note' || r.kind === 'thought'
            ? r.kind
            : 'conversation';
        return {
          id: r.id,
          kind,
          content: r.content,
          createdAt: typeof r.created_at === 'string' ? r.created_at : '',
          similarity: typeof r.similarity === 'number' ? r.similarity : 0,
        };
      })
      .filter((m): m is RecalledMemory => m !== null);
  } catch (err) {
    warn('recall', err);
    return [];
  }
}

/**
 * Convenience wrapper that formats recalled memories as a compact,
 * citation-friendly block for injection into an LLM system prompt. Returns
 * an empty string when there is nothing to recall, so the caller can append
 * unconditionally.
 */
export function formatRecallForPrompt(memories: RecalledMemory[]): string {
  if (memories.length === 0) return '';
  const lines = memories.map((m, i) => {
    const when = m.createdAt.length >= 10 ? m.createdAt.slice(0, 10) : 'unknown date';
    return `${i + 1}. (${when}) ${m.content}`;
  });
  return [
    '\n\n[MEMORY]',
    'Things BMO already knows from earlier conversations (use them when relevant; do not read them out verbatim):',
    ...lines,
    '[/MEMORY]',
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* recentTurns — short-term conversational history                            */
/* -------------------------------------------------------------------------- */

/** One past exchange, parsed back into child + BMO turns. */
export interface RecentTurn {
  child: string;
  bmo: string;
  createdAt: string;
}

/**
 * Returns the most recent conversation exchanges in CHRONOLOGICAL order
 * (oldest first), parsed from the stored "Child said / BMO replied" capture
 * format. Unlike {@link recall}, this is a plain recency read — no embeddings,
 * no similarity — so it gives BMO actual short-term dialogue memory: the thing
 * that lets a follow-up like "merah" be understood as answering BMO's previous
 * question. Always resolves; degrades to [] on any failure.
 *
 * `withinMinutes` bounds it to the current sitting so BMO doesn't treat a
 * conversation from yesterday as the immediate context.
 */
export async function recentTurns(
  limit = 6,
  withinMinutes = 20,
): Promise<RecentTurn[]> {
  if (isRemoteBrain()) return [];
  try {
    const supabase = getServiceClient();
    const sinceIso = new Date(Date.now() - withinMinutes * 60_000).toISOString();
    const { data, error } = await supabase
      .from('brain_memory')
      .select('content, created_at')
      .eq('kind', 'conversation')
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error !== null) {
      warn('recentTurns', error.message);
      return [];
    }
    if (!Array.isArray(data)) return [];
    const turns: RecentTurn[] = [];
    for (const row of data) {
      if (typeof row !== 'object' || row === null) continue;
      const r = row as Record<string, unknown>;
      if (typeof r.content !== 'string') continue;
      // Stored as: Child said: "..."\nBMO replied: "..."
      const m = /Child said:\s*"([\s\S]*?)"\s*\nBMO replied:\s*"([\s\S]*?)"\s*$/.exec(
        r.content,
      );
      if (m === null) continue;
      turns.push({
        child: m[1] ?? '',
        bmo: m[2] ?? '',
        createdAt: typeof r.created_at === 'string' ? r.created_at : '',
      });
    }
    // DB gave newest-first; flip to oldest-first for chat history order.
    return turns.reverse();
  } catch (err) {
    warn('recentTurns', err);
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* capture — write the exchange down                                           */
/* -------------------------------------------------------------------------- */

/**
 * Persists a piece of content to memory with its embedding. Fire-and-forget
 * safe: always resolves, never throws. Returns the new row id on success or
 * null when the capture was skipped or failed.
 *
 * Skips trivially short content; truncates very long content.
 */
export async function capture(
  content: string,
  options: CaptureOptions = {},
): Promise<string | null> {
  const trimmed = content.trim();
  if (trimmed.length < MIN_CAPTURE_CHARS) return null;
  const clipped = trimmed.length > MAX_CAPTURE_CHARS ? trimmed.slice(0, MAX_CAPTURE_CHARS) : trimmed;

  if (isRemoteBrain()) {
    return captureRemote(clipped, options);
  }

  const vec = await embedOne(clipped, options.signal);
  // We still store the row even if embedding failed — it just won't be
  // recallable by similarity until a future re-embed. Recall tolerates null
  // embeddings (the SQL filters them out).
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from('brain_memory')
      .insert({
        kind: options.kind ?? 'conversation',
        content: clipped,
        embedding: vec,
      })
      .select('id')
      .single();
    if (error !== null) {
      warn('capture', error.message);
      return null;
    }
    if (data !== null && typeof data === 'object' && 'id' in data) {
      const id = (data as { id: unknown }).id;
      return typeof id === 'string' ? id : null;
    }
    return null;
  } catch (err) {
    warn('capture', err);
    return null;
  }
}

/**
 * Captures one conversational exchange (user turn + BMO reply) as a single
 * memory, then fires the gbrain-style enrichment passes (self-wiring graph +
 * profile fact extraction) against the stored row. Formatted so recall
 * returns useful, self-describing context. Fire-and-forget: callers should
 * NOT await this on the hot path (use `after()` on Vercel).
 *
 * Enrichment is best-effort and fully degradable: if the graph/profile tables
 * or their migrations are absent, the extra passes no-op and the plain
 * capture still succeeds.
 */
export async function captureExchange(
  userText: string,
  replyText: string,
  signal?: AbortSignal,
): Promise<void> {
  const u = userText.trim();
  const r = replyText.trim();
  if (u.length === 0 && r.length === 0) return;
  const content = `Child said: "${u}"\nBMO replied: "${r}"`;
  const memoryId = await capture(content, { kind: 'conversation', signal });

  // Enrichment passes (gbrain layer). Lazy-imported so the hot-path module
  // doesn't eagerly pull the whole brain core, and so a failure to load any
  // enrichment module can never break plain capture. Each call already
  // degrades to a no-op internally.
  try {
    const [{ autoLinkMemory }, { extractFactsFromExchange }] = await Promise.all([
      import('@/lib/brain/entities'),
      import('@/lib/brain/profile'),
    ]);
    const tasks: Array<Promise<unknown>> = [
      extractFactsFromExchange(u, r, signal),
    ];
    if (memoryId !== null) {
      tasks.push(autoLinkMemory(memoryId, content, signal));
    }
    await Promise.allSettled(tasks);
  } catch (err) {
    warn('enrich', err);
  }
}

/* -------------------------------------------------------------------------- */
/* remote gbrain (VPS) — reserved seam, not wired yet                          */
/* -------------------------------------------------------------------------- */

/**
 * Placeholder for the real gbrain HTTP/MCP path. Intentionally returns empty
 * until the daemon contract is wired so that setting GBRAIN_HTTP_URL without
 * finishing the integration degrades safely rather than erroring.
 *
 * When implemented, this will POST an MCP `search` (or `think`) tool call to
 * `${GBRAIN_HTTP_URL}/mcp` with `Authorization: Bearer ${GBRAIN_TOKEN}` and
 * map the response into RecalledMemory[].
 */
async function recallRemote(_query: string, _options: RecallOptions): Promise<RecalledMemory[]> {
  warn('recall', 'GBRAIN_HTTP_URL set but remote brain path is not wired yet; skipping recall');
  return [];
}

/**
 * Placeholder for remote gbrain capture (`capture`/`ingest` MCP tool).
 */
async function captureRemote(_content: string, _options: CaptureOptions): Promise<string | null> {
  warn('capture', 'GBRAIN_HTTP_URL set but remote brain path is not wired yet; skipping capture');
  return null;
}
