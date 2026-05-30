import 'server-only';

import { brainWarn } from './contracts';
import { diagnose } from './doctor';
import { getProfile } from './profile';

/**
 * BMO BRAIN CORE — public barrel for the "gbrain layer".
 *
 * This file is the single import surface for everything under `lib/brain/`.
 * Callers reach the whole brain through one path:
 *
 *   import { think, hybridSearch, diagnose, brainSnapshot } from '@/lib/brain/index';
 *
 * The real gbrain (https://github.com/garrytan/gbrain) is a stateful daemon:
 * its own Postgres, a self-wiring knowledge graph, a 24/7 "dream cycle" cron,
 * synthesis with gap analysis, and a 30+ tool MCP server. That daemon can't
 * run inside Vercel's stateless functions, so BMO reproduces gbrain's
 * load-bearing ideas on the stack it already has (Supabase pgvector +
 * OpenRouter embeddings). The hot path (capture + recall used by /api/brain)
 * lives in the parent module `@/lib/brain`; the submodules barrelled here own
 * the *enrichment and intelligence* layers gbrain is known for.
 *
 * --------------------------------------------------------------------------
 * Submodule map — what each file does and the gbrain feature it mirrors.
 * --------------------------------------------------------------------------
 *   ./contracts    — Shared, dependency-light contracts: MemoryKind, MemoryRow,
 *                    ScoredMemory, the embedding/reasoning model constants
 *                    (BRAIN_EMBEDDING_MODEL, BRAIN_EMBEDDING_DIMENSIONS,
 *                    BRAIN_REASONING_MODEL), and the small pure helpers every
 *                    submodule shares (brainWarn, cosineSimilarity). This is the
 *                    stable interface the other files import instead of each
 *                    other's implementation details.
 *
 *   ./entities     — Entity extraction + the self-wiring step. extractEntities()
 *                    pulls people/places/topics (ExtractedEntity/EntityType) out
 *                    of a memory; autoLinkMemory() wires those entities into the
 *                    knowledge graph. Mirrors gbrain's automatic graph growth:
 *                    the brain gets richer the more BMO is used, no manual
 *                    curation required.
 *
 *   ./graph        — The self-wiring knowledge graph itself: upsertEntity,
 *                    addEdge, neighbors, relatedMemories, GraphEntity. This is
 *                    gbrain's knowledge-graph feature — entities and the typed
 *                    edges between them, plus traversal back to the memories
 *                    that mention them.
 *
 *   ./synthesize   — think() + SynthesisResult. gbrain's `think`: retrieve, then
 *                    synthesize an answer AND surface gaps (what the brain does
 *                    not yet know). The think/search split is deliberate —
 *                    `think` reasons, `search` only retrieves.
 *
 *   ./salience     — Importance scoring + dedup: scoreSalience, persistSalience,
 *                    markAccessed, findDuplicates, DuplicateGroup. Decides what
 *                    matters and what is redundant, feeding the dream cycle.
 *
 *   ./consolidate  — runDreamCycle() + DreamReport. gbrain's 24/7 "dream cycle":
 *                    the offline pass that consolidates, dedupes, and re-scores
 *                    memory so recall quality improves over time without a human
 *                    in the loop.
 *
 *   ./doctor       — diagnose() + BrainCheck/BrainHealth. gbrain's `gbrain
 *                    doctor`: built-in health checks (table reachable, memories
 *                    present, embeddings present, embedding provider, recall RPC)
 *                    rolled up into a single 0..100 score with a per-check
 *                    breakdown. The "is my brain actually wired up?" smoke test.
 *
 *   ./search       — hybridSearch() + HybridHit. gbrain-style hybrid retrieval:
 *                    semantic (vector) + lexical signals fused with Reciprocal
 *                    Rank Fusion (RRF) for results that beat either signal alone.
 *
 *   ./timeline     — recordEvent, trajectory, recentEvents, TimelineEvent,
 *                    EventKind. gbrain's `find_trajectory`: the temporal view of
 *                    memory — what happened, in what order, and how a topic
 *                    evolved across time.
 *
 *   ./profile      — rememberFact, getProfile, profileSummary,
 *                    extractFactsFromExchange, ProfileFact. Profile enrichment:
 *                    durable facts about the user distilled from exchanges, so
 *                    BMO accumulates a stable picture of who it is talking to.
 *
 * --------------------------------------------------------------------------
 * Discipline: everything degrades gracefully, never throws on the brain path.
 * --------------------------------------------------------------------------
 * The brain is an ENHANCEMENT, never a hard dependency. Every function in
 * every submodule is built to resolve to a safe empty/no-op value and log a
 * warning (see {@link brainWarn}) when its backing table, RPC, or upstream
 * call is unavailable. The /api/brain route must never 502 because a brain
 * function failed. The {@link brainSnapshot} orchestrator below follows the
 * same rule: any failure collapses to a safe default rather than throwing.
 *
 * --------------------------------------------------------------------------
 * Migration path to a real gbrain daemon on a VPS.
 * --------------------------------------------------------------------------
 * When you stand up a real `gbrain serve --http` on a VPS and set
 * `GBRAIN_HTTP_URL` (+ `GBRAIN_TOKEN`), the hot-path seam in the parent
 * `@/lib/brain` flips capture/recall over to the daemon's MCP endpoint instead
 * of Supabase. The wire format, the brain route, and the firmware never
 * change. The enrichment submodules barrelled here are designed to be the
 * pieces a real gbrain daemon eventually subsumes; until then they run locally
 * on Supabase + OpenRouter.
 */

/* -------------------------------------------------------------------------- */
/* Re-exports — the full brain core surface.                                   */
/* -------------------------------------------------------------------------- */

export * from './contracts';
export * from './entities';
export * from './graph';
export * from './synthesize';
export * from './salience';
export * from './consolidate';
export * from './doctor';
export * from './search';
export * from './timeline';
export * from './profile';

/* -------------------------------------------------------------------------- */
/* Orchestration convenience.                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A one-shot read of the brain's overall state: its rolled-up health plus the
 * durable facts it knows about the user. Cheap to render on a status/admin
 * surface without wiring up doctor and profile separately.
 */
export interface BrainSnapshot {
  health: import('./doctor').BrainHealth;
  profile: import('./profile').ProfileFact[];
}

/** Safe default returned when the snapshot cannot be assembled. */
const SAFE_SNAPSHOT: BrainSnapshot = {
  health: { score: 0, checks: [], memoryCount: 0, embeddedCount: 0 },
  profile: [],
};

/**
 * Assembles a {@link BrainSnapshot} by running {@link diagnose} and
 * {@link getProfile} concurrently.
 *
 * Follows the brain-core discipline: never throws. On any failure — a
 * submodule rejecting, a missing table, an unreachable upstream — it logs a
 * warning and resolves to {@link SAFE_SNAPSHOT} (score 0, empty checks, empty
 * profile) so callers can render unconditionally.
 */
export async function brainSnapshot(): Promise<BrainSnapshot> {
  try {
    const [health, profile] = await Promise.all([diagnose(), getProfile()]);
    return { health, profile };
  } catch (err) {
    brainWarn('snapshot', err);
    return SAFE_SNAPSHOT;
  }
}
