-- Migration 0007: brain timeline / trajectory — how an entity changes over time.
--
-- This layer reproduces gbrain's (https://github.com/garrytan/gbrain)
-- `find_trajectory` idea on the stack BMO already has. Where
-- 0003_brain_memory.sql stores *what was said* as vector-searchable rows and
-- 0004_brain_graph.sql stores *what those memories are about* as a graph, this
-- migration stores *how a topic moves through time*: an append-only log of
-- dated events tied to an entity (a person, a feeling, a recurring activity, a
-- growth moment).
--
-- For BMO — a child's companion toy — the trajectory of an entity is the
-- emotional/biographical answer to "what has happened with X over time": the
-- child's feelings about school across weeks, recurring activities, milestones
-- ("lost a tooth", "learned to ride a bike"), and noted changes. The sibling
-- `timeline.ts` module records events and reads them back in chronological
-- order so BMO can reflect on growth instead of treating every turn as new.
--
--   * brain_events — one dated event about an entity (the trajectory points).
--
-- Same security posture as every other table: RLS on, the anon key can touch
-- nothing, only the server-side service-role key reads and writes.
--
-- Run this in the Supabase SQL editor after 0004_brain_graph.sql.

begin;

-- ----------------------------------------------------------------------------
-- brain_events: append-only timeline of things that happened to an entity.
--
-- `entity` is the free-text topic/person/thing the event is about; the
-- timeline.ts module matches it case-insensitively so "School", "school", and
-- "SCHOOL" all share one trajectory. `kind` classifies the event so a reader
-- can distinguish a milestone from a fleeting feeling. `summary` is the human
-- description of what happened. `occurred_at` is when it happened (which may
-- differ from `created_at`, when it was recorded) so back-dated events sort
-- correctly along the trajectory.
-- ----------------------------------------------------------------------------
create table if not exists public.brain_events (
  id          uuid        primary key default gen_random_uuid(),
  entity      text        not null,
  kind        text        not null default 'note'
                check (kind in ('milestone', 'feeling', 'activity', 'change', 'note')),
  summary     text        not null check (length(summary) >= 1),
  occurred_at timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

-- Per-entity trajectory: pull one entity's events newest-first (the module
-- re-sorts ascending for chronological reads). Composite so the entity filter
-- and the time ordering are served by a single index.
create index if not exists brain_events_entity_occurred_at_desc
  on public.brain_events (entity, occurred_at desc);

-- Cross-entity recency: newest events across the whole brain.
create index if not exists brain_events_occurred_at_desc
  on public.brain_events (occurred_at desc);

alter table public.brain_events enable row level security;

drop policy if exists brain_events_no_anon on public.brain_events;
create policy brain_events_no_anon
  on public.brain_events
  for all
  to anon
  using (false);

commit;
