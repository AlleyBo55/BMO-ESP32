-- Migration 0004: brain knowledge graph — BMO's self-wiring concept map.
--
-- This layer reproduces the load-bearing idea behind gbrain's
-- (https://github.com/garrytan/gbrain) self-wiring knowledge graph on the
-- stack BMO already has. Where 0003_brain_memory.sql stores *what was said*
-- as vector-searchable rows, this migration stores *what those memories are
-- about* as a graph: entities (people, places, things, activities, concepts)
-- and the typed edges between them.
--
-- The graph grows automatically. As BMO talks, the sibling `entities.ts`
-- module extracts entities from each captured memory, upserts them here,
-- links them to their source memory through the join table, and wires edges
-- between co-occurring entities. Over time this turns a flat pile of
-- memories into a navigable map: given "Doraemon" BMO can hop to related
-- concepts and pull every memory that ever mentioned them.
--
--   * brain_entities         — the nodes (deduped by a lowercased name_key).
--   * brain_edges            — the typed, directed connections between nodes.
--   * brain_memory_entities  — join table: which memory mentions which node.
--
-- Same security posture as every other table: RLS on, the anon key can
-- touch nothing, only the server-side service-role key reads and writes.
--
-- Run this in the Supabase SQL editor after 0003_brain_memory.sql.

begin;

-- ----------------------------------------------------------------------------
-- brain_entities: the graph nodes.
--
-- `name` keeps the original casing for display; `name_key` is the lowercased
-- match key the graph dedupes on (so "Doraemon", "doraemon", and "DORAEMON"
-- all resolve to one node). `type` is a coarse classification used when
-- rendering or filtering the graph.
-- ----------------------------------------------------------------------------
create table if not exists public.brain_entities (
  id         uuid        primary key default gen_random_uuid(),
  name       text        not null,
  name_key   text        not null unique,
  type       text        not null default 'concept'
               check (type in ('person', 'place', 'thing', 'activity', 'concept')),
  created_at timestamptz not null default now()
);

create index if not exists brain_entities_name_key_idx
  on public.brain_entities (name_key);

alter table public.brain_entities enable row level security;

drop policy if exists brain_entities_no_anon on public.brain_entities;
create policy brain_entities_no_anon
  on public.brain_entities
  for all
  to anon
  using (false);

-- ----------------------------------------------------------------------------
-- brain_edges: typed, directed connections between two entities.
--
-- Both endpoints cascade-delete with their entity so a removed node never
-- leaves a dangling edge. The unique triple keeps edge insertion idempotent:
-- re-wiring the same relationship is a no-op rather than a duplicate.
-- ----------------------------------------------------------------------------
create table if not exists public.brain_edges (
  id          uuid        primary key default gen_random_uuid(),
  from_entity uuid        not null references public.brain_entities(id) on delete cascade,
  to_entity   uuid        not null references public.brain_entities(id) on delete cascade,
  type        text        not null default 'related',
  created_at  timestamptz default now(),
  unique (from_entity, to_entity, type)
);

create index if not exists brain_edges_from_entity_idx
  on public.brain_edges (from_entity);

create index if not exists brain_edges_to_entity_idx
  on public.brain_edges (to_entity);

alter table public.brain_edges enable row level security;

drop policy if exists brain_edges_no_anon on public.brain_edges;
create policy brain_edges_no_anon
  on public.brain_edges
  for all
  to anon
  using (false);

-- ----------------------------------------------------------------------------
-- brain_memory_entities: join table linking a memory to the entities it
-- mentions. Populated by the sibling entities.ts module. `memory_id` points
-- at public.brain_memory(id); the unique pair keeps the link idempotent so
-- re-processing a memory does not duplicate rows.
-- ----------------------------------------------------------------------------
create table if not exists public.brain_memory_entities (
  id         uuid        primary key default gen_random_uuid(),
  memory_id  uuid        not null,
  entity_id  uuid        not null references public.brain_entities(id) on delete cascade,
  created_at timestamptz default now(),
  unique (memory_id, entity_id)
);

create index if not exists brain_memory_entities_memory_id_idx
  on public.brain_memory_entities (memory_id);

alter table public.brain_memory_entities enable row level security;

drop policy if exists brain_memory_entities_no_anon on public.brain_memory_entities;
create policy brain_memory_entities_no_anon
  on public.brain_memory_entities
  for all
  to anon
  using (false);

commit;
