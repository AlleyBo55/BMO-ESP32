import 'server-only';

/**
 * Shared contracts for the BMO brain core (the "gbrain layer").
 *
 * This file is the stable interface every brain submodule under `lib/brain/`
 * imports from. It is intentionally dependency-light (types + a few small
 * pure helpers) so the submodules — built independently — interoperate
 * without importing each other's implementation details.
 *
 * Architecture recap: the real gbrain (github.com/garrytan/gbrain) is a
 * stateful daemon. BMO reproduces its load-bearing ideas on Supabase +
 * OpenRouter. The top-level `lib/brain.ts` owns the hot path (capture +
 * recall used by /api/brain). The submodules here own the *enrichment and
 * intelligence* layers gbrain is known for: knowledge graph, synthesis with
 * gap analysis, salience/consolidation, the dream cycle, entity extraction,
 * and brain health/doctor checks. Each is invocable on its own and degrades
 * to a safe no-op when its backing table or an upstream call is unavailable.
 */

export type MemoryKind = 'conversation' | 'fact' | 'note';

/** A stored memory row, mirrors public.brain_memory. */
export interface MemoryRow {
  id: string;
  kind: MemoryKind;
  content: string;
  createdAt: string;
}

/** A recalled memory with similarity score (0..1). */
export interface ScoredMemory extends MemoryRow {
  similarity: number;
}

/** Embedding model + dimensionality shared across the brain core. */
export const BRAIN_EMBEDDING_MODEL = 'openai/text-embedding-3-small';
export const BRAIN_EMBEDDING_DIMENSIONS = 1536;

/** Default LLM used for brain-internal reasoning (synthesis, extraction). */
export const BRAIN_REASONING_MODEL = 'openai/gpt-4.1-mini';

/**
 * Standard degraded-mode warning used by every brain submodule. Keeps the
 * "never throw on the brain path" discipline uniform and greppable.
 */
export function brainWarn(scope: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`[brain:${scope}] degraded (non-fatal): ${msg}`);
}

/** Cosine similarity between two equal-length vectors; 0 on mismatch. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
