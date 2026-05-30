-- Migration 0009: random thoughts — BMO's spontaneous inner monologue.
--
-- This extends the gbrain layer (see 0003_brain_memory.sql) with a fourth
-- memory kind, 'thought'. The real gbrain / OpenClaw idea this mirrors is the
-- 24/7 "dream cycle": an agent that keeps thinking on its own — synthesizing,
-- wondering, connecting ideas — even when no one is talking to it, and folds
-- those musings back into its own memory so it grows over time.
--
-- For BMO that means: every few minutes the device asks the dashboard for an
-- idle "random thought". The dashboard recalls what BMO already knows (memory
-- + child profile), has gpt-4.1-mini muse out loud in BMO's voice, SPEAKS it
-- through TTS, AND captures the musing back into brain_memory as kind
-- 'thought'. Because thoughts are stored like any other memory, they surface
-- in future recall — so BMO's spontaneous thoughts compound into a richer,
-- more "alive" inner life. That self-feeding loop is what makes BMO feel
-- sentient rather than purely reactive.
--
-- The only schema change required is widening the `kind` CHECK constraint to
-- admit 'thought'. Everything else (embedding, recall RPC, salience, dedup)
-- already works on any row regardless of kind.
--
-- Run this in the Supabase SQL editor after 0008_brain_search.sql. Idempotent.

begin;

-- Widen the kind check constraint to include 'thought'. The constraint name
-- is the Postgres default for a column CHECK on public.brain_memory.kind.
-- Drop-then-add so re-running this migration is safe.
alter table public.brain_memory
  drop constraint if exists brain_memory_kind_check;

alter table public.brain_memory
  add constraint brain_memory_kind_check
  check (kind in ('conversation', 'fact', 'note', 'thought'));

commit;
