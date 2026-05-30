-- Migration 0005: brain salience + dedup.
--
-- Two enrichment ideas borrowed from gbrain's consolidation / "dream cycle":
--
--   1. Salience  — not every memory is equally worth keeping. A child's
--                  companion toy should remember the meaningful things (a
--                  pet's name, a fear, a favourite story) more strongly than
--                  filler small-talk. We attach a 0..1 salience score plus
--                  lightweight access bookkeeping (last_accessed_at,
--                  access_count) so future consolidation can decay, boost, or
--                  prune rows on principled grounds.
--
--   2. Dedup     — auto-growing memory accumulates near-duplicates (the same
--                  fact restated across turns). find_duplicate_memories pairs
--                  rows whose embeddings are near-identical so a caller can
--                  collapse them, always keeping the OLDER row as canonical.
--
-- These columns and the RPC are additive: lib/brain.ts's hot path
-- (capture/recall) is unaffected and keeps working if this migration has not
-- run yet (the salience module degrades to a no-op).
--
-- Run this in the Supabase SQL editor after 0003_brain_memory.sql.

begin;

-- Salience: how important/memorable a memory is, 0..1. Defaults to a neutral
-- 0.5 so pre-existing and un-scored rows sit in the middle until rated.
alter table public.brain_memory
  add column if not exists salience real not null default 0.5;

-- When this memory was last surfaced by recall. Null until first accessed.
alter table public.brain_memory
  add column if not exists last_accessed_at timestamptz;

-- How many times this memory has been surfaced. Cheap recency/usefulness signal.
alter table public.brain_memory
  add column if not exists access_count integer not null default 0;

-- Lets consolidation scan the most/least salient rows without a full sort.
create index if not exists brain_memory_salience_desc
  on public.brain_memory (salience desc);

-- ----------------------------------------------------------------------------
-- find_duplicate_memories: pair up near-identical memories for collapsing.
--
-- Self-joins brain_memory on cosine similarity >= similarity_threshold. The
-- `a.id < b.id` guard keeps each unordered pair once and avoids self-pairs;
-- both embeddings must be present. The OLDER row (smaller created_at) is
-- returned as keep_id so the caller drops the newer restatement and preserves
-- the original. Ties on created_at fall back to id ordering for determinism.
-- ----------------------------------------------------------------------------
create or replace function public.find_duplicate_memories(
  similarity_threshold float default 0.95,
  max_pairs            int   default 100
)
returns table (
  keep_id    uuid,
  drop_id    uuid,
  similarity float
)
language sql
stable
as $$
  select
    case
      when a.created_at <= b.created_at then a.id
      else b.id
    end as keep_id,
    case
      when a.created_at <= b.created_at then b.id
      else a.id
    end as drop_id,
    1 - (a.embedding <=> b.embedding) as similarity
  from public.brain_memory a
  join public.brain_memory b
    on a.id < b.id
  where a.embedding is not null
    and b.embedding is not null
    and 1 - (a.embedding <=> b.embedding) >= similarity_threshold
  order by similarity desc
  limit greatest(max_pairs, 1);
$$;

commit;
