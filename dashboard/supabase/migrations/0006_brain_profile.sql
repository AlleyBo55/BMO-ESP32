-- Migration 0006: brain child profile — the durable portrait of BMO's kid.
--
-- BMO is a companion toy for one child. Where 0003_brain_memory.sql stores
-- the raw stream of *what was said* and 0004_brain_graph.sql maps *what those
-- memories are about*, this layer holds the slowly-evolving PROFILE of the
-- single primary user: their name, age, favourite things, fears, friends,
-- and preferences. It is gbrain's (https://github.com/garrytan/gbrain)
-- "enrich the entity over time" idea applied to the one child BMO belongs to.
--
-- The profile is stored as a small set of key -> value facts, each carrying a
-- 0..1 confidence score so a freshly-inferred guess ("maybe afraid of the
-- dark") can sit alongside a hard-stated fact ("namanya Budi") and be weighed
-- accordingly. The sibling `lib/brain/profile.ts` module upserts facts by
-- key (so a fact updates in place rather than accumulating duplicates) and
-- reads them back highest-confidence first.
--
-- Same security posture as every other table: RLS on, the anon key can touch
-- nothing, only the server-side service-role key reads and writes. The table
-- is additive — lib/brain.ts's hot path (capture/recall) is unaffected and
-- keeps working if this migration has not run yet (the profile module
-- degrades to a no-op).
--
-- Run this in the Supabase SQL editor after 0003_brain_memory.sql.

begin;

-- ----------------------------------------------------------------------------
-- brain_profile: key -> value facts about the child.
--
-- `fact_key` is the normalized, deduped match key (lowercased, spaces folded
-- to underscores by the module) and is UNIQUE so each attribute exists at
-- most once — remembering a fact again updates the value/confidence in place.
-- `confidence` is constrained to 0..1; 0.6 is a neutral "reasonably sure"
-- default for newly-inferred facts. `updated_at` tracks the last write so the
-- module (and any future consolidation) can prefer fresher knowledge.
-- ----------------------------------------------------------------------------
create table if not exists public.brain_profile (
  id          uuid        primary key default gen_random_uuid(),
  fact_key    text        not null unique,
  fact_value  text        not null,
  confidence  real        not null default 0.6
                check (confidence >= 0 and confidence <= 1),
  updated_at  timestamptz not null default now()
);

create index if not exists brain_profile_updated_at_desc
  on public.brain_profile (updated_at desc);

alter table public.brain_profile enable row level security;

drop policy if exists brain_profile_no_anon on public.brain_profile;
create policy brain_profile_no_anon
  on public.brain_profile
  for all
  to anon
  using (false);

commit;
