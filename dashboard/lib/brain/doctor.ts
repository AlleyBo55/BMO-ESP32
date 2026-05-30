import 'server-only';

import { embed } from '@/lib/openrouter';
import { getServiceClient } from '@/lib/supabase-admin';
import {
  BRAIN_EMBEDDING_DIMENSIONS,
  BRAIN_EMBEDDING_MODEL,
  brainWarn,
} from '@/lib/brain/contracts';

/**
 * BRAIN DOCTOR — BMO's `gbrain doctor` for the brain core.
 *
 * The real gbrain (https://github.com/garrytan/gbrain) ships a `gbrain doctor`
 * command: a set of built-in health checks that probe the daemon's moving
 * parts (database reachability, embedding provider, recall index) and report a
 * single rolled-up score alongside a per-check pass/fail breakdown. It's the
 * "is my brain actually wired up correctly?" smoke test you run after install
 * or when recall starts misbehaving.
 *
 * This reproduces that for BMO's brain, which lives on Supabase pgvector +
 * OpenRouter embeddings rather than a standalone daemon. {@link diagnose}
 * exercises the same load-bearing surfaces the hot path (capture/recall in
 * `lib/brain.ts`) depends on:
 *
 *   1. table_reachable    — can we even reach `brain_memory`?
 *   2. has_memories       — is there anything stored to recall?
 *   3. embeddings_present — are the stored rows actually embedded?
 *   4. embedding_provider — does OpenRouter return a vector of the right width?
 *   5. recall_rpc         — does the `match_brain_memory` RPC respond?
 *
 * Graceful degradation (important): mirroring the rest of the brain core, a
 * check that throws does not abort the diagnosis — it becomes a failed
 * {@link BrainCheck} carrying the error text in `detail`. {@link diagnose}
 * NEVER throws; a totally broken brain returns score 0 with every check failed.
 */

/** Result of a single health check. */
export interface BrainCheck {
  id: string;
  ok: boolean;
  detail: string;
}

/** Rolled-up brain health: 0..100 score plus the individual checks. */
export interface BrainHealth {
  score: number;
  checks: BrainCheck[];
  memoryCount: number;
  embeddedCount: number;
}

/** Normalizes any thrown value into a printable detail string. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs every brain health check and returns a rolled-up {@link BrainHealth}.
 *
 * Always resolves: each check is individually guarded so an upstream failure
 * (missing table, unreachable embedding provider, absent RPC) degrades to a
 * single failed check rather than rejecting the whole diagnosis.
 */
export async function diagnose(): Promise<BrainHealth> {
  const checks: BrainCheck[] = [];
  let memoryCount = 0;
  let embeddedCount = 0;

  const supabase = getServiceClient();

  /* 1. table_reachable — a head count query on brain_memory must succeed. */
  try {
    const { count, error } = await supabase
      .from('brain_memory')
      .select('*', { count: 'exact', head: true });
    if (error !== null) {
      checks.push({ id: 'table_reachable', ok: false, detail: error.message });
    } else {
      memoryCount = count ?? 0;
      checks.push({
        id: 'table_reachable',
        ok: true,
        detail: `brain_memory reachable (${memoryCount} rows)`,
      });
    }
  } catch (err) {
    brainWarn('doctor:table_reachable', err);
    checks.push({ id: 'table_reachable', ok: false, detail: errText(err) });
  }

  /* 2. has_memories — there is at least one stored memory. */
  checks.push({
    id: 'has_memories',
    ok: memoryCount > 0,
    detail:
      memoryCount > 0
        ? `${memoryCount} memories stored`
        : 'no memories stored yet',
  });

  /* 3. embeddings_present — every stored row carries an embedding. */
  try {
    const { count, error } = await supabase
      .from('brain_memory')
      .select('*', { count: 'exact', head: true })
      .not('embedding', 'is', null);
    if (error !== null) {
      checks.push({ id: 'embeddings_present', ok: false, detail: error.message });
    } else {
      embeddedCount = count ?? 0;
      const ok = memoryCount === 0 || embeddedCount === memoryCount;
      checks.push({
        id: 'embeddings_present',
        ok,
        detail: `${embeddedCount}/${memoryCount} embedded`,
      });
    }
  } catch (err) {
    brainWarn('doctor:embeddings_present', err);
    checks.push({ id: 'embeddings_present', ok: false, detail: errText(err) });
  }

  /* 4. embedding_provider — OpenRouter returns a vector of the expected width. */
  try {
    const res = await embed({
      model: BRAIN_EMBEDDING_MODEL,
      input: 'tes',
      dimensions: BRAIN_EMBEDDING_DIMENSIONS,
    });
    const vec = res.embeddings[0];
    const length = vec?.length ?? 0;
    const ok = length === BRAIN_EMBEDDING_DIMENSIONS;
    checks.push({
      id: 'embedding_provider',
      ok,
      detail: ok
        ? `${BRAIN_EMBEDDING_MODEL} returned ${length}-dim vector`
        : `expected ${BRAIN_EMBEDDING_DIMENSIONS} dims, got ${length}`,
    });
  } catch (err) {
    brainWarn('doctor:embedding_provider', err);
    checks.push({ id: 'embedding_provider', ok: false, detail: errText(err) });
  }

  /* 5. recall_rpc — the match_brain_memory RPC exists and responds. */
  try {
    const zeroVector = new Array<number>(BRAIN_EMBEDDING_DIMENSIONS).fill(0);
    const { error } = await supabase.rpc('match_brain_memory', {
      query_embedding: zeroVector,
      match_count: 1,
    });
    if (error !== null) {
      checks.push({ id: 'recall_rpc', ok: false, detail: error.message });
    } else {
      checks.push({
        id: 'recall_rpc',
        ok: true,
        detail: 'match_brain_memory responded',
      });
    }
  } catch (err) {
    brainWarn('doctor:recall_rpc', err);
    checks.push({ id: 'recall_rpc', ok: false, detail: errText(err) });
  }

  const okCount = checks.reduce((n, c) => (c.ok ? n + 1 : n), 0);
  const totalChecks = checks.length;
  const score = totalChecks === 0 ? 0 : Math.round((100 * okCount) / totalChecks);

  return { score, checks, memoryCount, embeddedCount };
}
