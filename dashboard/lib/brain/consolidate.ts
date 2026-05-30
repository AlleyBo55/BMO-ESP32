import 'server-only';

import { brainWarn } from '@/lib/brain/contracts';
import { findDuplicates, persistSalience, scoreSalience } from '@/lib/brain/salience';
import { getServiceClient } from '@/lib/supabase-admin';

/**
 * consolidate — BMO's "dream cycle" (the gbrain enrichment pass).
 *
 * The real gbrain (github.com/garrytan/gbrain) runs a 24/7 cron daemon that,
 * while the user sleeps, walks its memory store to: dedup near-identical
 * recollections, (re)score how salient each memory is, and enrich the graph.
 * BMO has no persistent daemon — it lives in Vercel's stateless functions —
 * so we approximate the dream cycle as an *on-demand* pass triggered by a
 * cron/manual call (see `app/api/brain/dream/route.ts`).
 *
 * This module is the orchestrator. The actual intelligence lives in sibling
 * brain submodules (`lib/brain/salience`); `runDreamCycle` just sequences
 * them and accounts for the work done.
 *
 * --------------------------------------------------------------------------
 * Graceful degradation (load-bearing).
 * --------------------------------------------------------------------------
 * The dream cycle is pure enrichment — nothing on the hot path depends on it.
 * Every step is wrapped so a failure (missing table, upstream embedding/LLM
 * error, RPC error) records a human-readable note and the cycle continues
 * with the next step. `runDreamCycle` NEVER throws; the worst case is a
 * report whose counts are zero and whose `notes` explain why.
 */

/**
 * Summary of one dream-cycle pass.
 *
 *   - scanned:  duplicate groups inspected (from `findDuplicates`).
 *   - merged:   memories deleted as duplicates of a kept row.
 *   - rescored: memories whose salience was recomputed and persisted.
 *   - ms:       wall-clock duration of the whole pass.
 *   - notes:    human-readable trace, including any degraded steps.
 */
export interface DreamReport {
  scanned: number;
  merged: number;
  rescored: number;
  ms: number;
  notes: string[];
}

/** How many un-scored memories to rescore per pass when not overridden. */
const DEFAULT_MAX_RESCORE = 25;

/**
 * Runs a single dream-cycle pass over `brain_memory`.
 *
 * Steps (each independently degradable):
 *   1. Dedup — `findDuplicates()` groups near-identical memories; the `drop`
 *      ids of every group are deleted from `brain_memory` and counted as
 *      `merged`. `scanned` reflects how many groups were inspected.
 *   2. Rescore — pick the oldest never-touched memories (those still on the
 *      0.5 default, i.e. `last_accessed_at is null`), ordered `created_at`
 *      ascending and capped at `maxRescore`, recompute each one's salience
 *      via `scoreSalience` and write it back with `persistSalience`, counting
 *      each success as `rescored`.
 *   3. Report — return the counts, total elapsed `ms`, and a `notes` trace.
 *
 * Always resolves; never throws.
 */
export async function runDreamCycle(
  options: { maxRescore?: number } = {},
): Promise<DreamReport> {
  const startedAt = Date.now();
  const maxRescore =
    typeof options.maxRescore === 'number' && options.maxRescore > 0
      ? Math.floor(options.maxRescore)
      : DEFAULT_MAX_RESCORE;

  const notes: string[] = [];
  let scanned = 0;
  let merged = 0;
  let rescored = 0;

  // -------------------- step 1: dedup ---------------------------------------
  // Collect every group's drop ids and delete them in one shot. Failures in
  // either the scan or the delete are noted and we move on to rescoring.
  try {
    const groups = await findDuplicates();
    scanned = groups.length;

    const dropIds: string[] = [];
    for (const group of groups) {
      for (const id of group.drop) {
        if (typeof id === 'string' && id.length > 0) dropIds.push(id);
      }
    }

    if (dropIds.length === 0) {
      notes.push(`dedup: scanned ${scanned} group(s), no duplicates to merge`);
    } else {
      try {
        const supabase = getServiceClient();
        const { error } = await supabase
          .from('brain_memory')
          .delete()
          .in('id', dropIds);
        if (error !== null) {
          notes.push(`dedup: delete failed (${error.message}); merged 0`);
        } else {
          merged = dropIds.length;
          notes.push(
            `dedup: scanned ${scanned} group(s), merged ${merged} duplicate(s)`,
          );
        }
      } catch (err) {
        brainWarn('consolidate.dedup', err);
        notes.push(`dedup: delete threw (${errMessage(err)}); merged 0`);
      }
    }
  } catch (err) {
    brainWarn('consolidate.dedup', err);
    notes.push(`dedup: skipped (${errMessage(err)})`);
  }

  // -------------------- step 2: rescore salience ----------------------------
  // The freshest-but-never-touched memories still carry the 0.5 default
  // salience (last_accessed_at is null). Pick the oldest of those so the
  // backlog drains in age order, then recompute + persist each score.
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from('brain_memory')
      .select('id, content')
      .is('last_accessed_at', null)
      .order('created_at', { ascending: true })
      .limit(maxRescore);

    if (error !== null) {
      notes.push(`rescore: select failed (${error.message}); rescored 0`);
    } else if (!Array.isArray(data) || data.length === 0) {
      notes.push('rescore: no un-scored memories found');
    } else {
      let attempted = 0;
      for (const row of data) {
        if (typeof row !== 'object' || row === null) continue;
        const r = row as Record<string, unknown>;
        if (typeof r.id !== 'string' || typeof r.content !== 'string') continue;
        attempted += 1;
        try {
          const score = await scoreSalience(r.content);
          await persistSalience(r.id, score);
          rescored += 1;
        } catch (err) {
          brainWarn('consolidate.rescore', err);
          notes.push(`rescore: memory ${r.id} failed (${errMessage(err)})`);
        }
      }
      notes.push(`rescore: rescored ${rescored}/${attempted} memory(ies)`);
    }
  } catch (err) {
    brainWarn('consolidate.rescore', err);
    notes.push(`rescore: skipped (${errMessage(err)})`);
  }

  return {
    scanned,
    merged,
    rescored,
    ms: Date.now() - startedAt,
    notes,
  };
}

/** Narrows an unknown thrown value to a printable message. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
