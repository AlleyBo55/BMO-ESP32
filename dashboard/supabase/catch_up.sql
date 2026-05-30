-- Catch-up migration: bring an existing BMO database fully up to date.
--
-- WHY: the original schema.sql was applied at setup, but the incremental
-- migrations (0001..0008) were never run, so the live DB is missing columns
-- and tables the current code expects — most visibly the `config.volume`
-- column (hence "Could not find the 'volume' column of 'config'").
--
-- This script is IDEMPOTENT: every statement uses `if not exists` / `add
-- column if not exists` / `create or replace`, so it is safe to run on a
-- partially-migrated database and safe to re-run. It folds in migrations
-- 0001 (songs), 0002 (volume), and 0003..0008 (the brain stack).
--
-- HOW TO RUN: paste the whole file into the Supabase SQL editor and execute.

begin;

-- ============================================================================
-- 0002: config.volume  (the column that's currently missing)
-- ============================================================================
alter table public.config
  add column if not exists volume integer not null default 60
    check (volume between 0 and 100);

-- ============================================================================
-- 0001: songs
-- ============================================================================
create table if not exists public.songs (
  id         uuid primary key default gen_random_uuid(),
  title      text not null check (length(title) >= 1 and length(title) <= 200),
  url        text not null check (url ~ '^https://'),
  added_at   timestamptz not null default now()
);
create index if not exists songs_title_idx on public.songs (title);
create index if not exists songs_added_at_desc on public.songs (added_at desc);
alter table public.songs enable row level security;
drop policy if exists songs_no_anon on public.songs;
create policy songs_no_anon on public.songs for all to anon using (false);

-- ============================================================================
-- 0003: brain_memory (+ vector) and the recall RPC
-- ============================================================================
create extension if not exists vector;

create table if not exists public.brain_memory (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null default 'conversation'
                check (kind in ('conversation', 'fact', 'note')),
  content     text not null check (length(content) >= 1),
  embedding   vector(1536),
  created_at  timestamptz not null default now()
);
create index if not exists brain_memory_embedding_idx
  on public.brain_memory using hnsw (embedding vector_cosine_ops);
create index if not exists brain_memory_created_at_desc
  on public.brain_memory (created_at desc);
alter table public.brain_memory enable row level security;
drop policy if exists brain_memory_no_anon on public.brain_memory;
create policy brain_memory_no_anon on public.brain_memory for all to anon using (false);

create or replace function public.match_brain_memory(
  query_embedding vector(1536),
  match_count     int   default 5,
  min_similarity  float default 0.0
)
returns table (id uuid, kind text, content text, created_at timestamptz, similarity float)
language sql stable as $$
  select m.id, m.kind, m.content, m.created_at,
         1 - (m.embedding <=> query_embedding) as similarity
  from public.brain_memory m
  where m.embedding is not null
    and 1 - (m.embedding <=> query_embedding) >= min_similarity
  order by m.embedding <=> query_embedding
  limit greatest(match_count, 1);
$$;

-- ============================================================================
-- 0005: salience + access bookkeeping + dedup RPC
-- ============================================================================
alter table public.brain_memory add column if not exists salience real not null default 0.5;
alter table public.brain_memory add column if not exists last_accessed_at timestamptz;
alter table public.brain_memory add column if not exists access_count integer not null default 0;
create index if not exists brain_memory_salience_desc on public.brain_memory (salience desc);

create or replace function public.find_duplicate_memories(
  similarity_threshold float default 0.95,
  max_pairs            int   default 100
)
returns table (keep_id uuid, drop_id uuid, similarity float)
language sql stable as $$
  select
    case when a.created_at <= b.created_at then a.id else b.id end as keep_id,
    case when a.created_at <= b.created_at then b.id else a.id end as drop_id,
    1 - (a.embedding <=> b.embedding) as similarity
  from public.brain_memory a
  join public.brain_memory b on a.id < b.id
  where a.embedding is not null and b.embedding is not null
    and 1 - (a.embedding <=> b.embedding) >= similarity_threshold
  order by similarity desc
  limit greatest(max_pairs, 1);
$$;

-- ============================================================================
-- 0008: full-text channel + keyword search RPC
-- ============================================================================
alter table public.brain_memory
  add column if not exists content_tsv tsvector
    generated always as (to_tsvector('simple', coalesce(content, ''))) stored;
create index if not exists brain_memory_tsv_idx
  on public.brain_memory using gin (content_tsv);

create or replace function public.keyword_search_memory(
  query_text  text,
  match_count int default 10
)
returns table (id uuid, kind text, content text, created_at timestamptz, rank real)
language sql stable as $$
  select m.id, m.kind, m.content, m.created_at,
         ts_rank(m.content_tsv, websearch_to_tsquery('simple', query_text)) as rank
  from public.brain_memory m
  where btrim(coalesce(query_text, '')) <> ''
    and m.content_tsv @@ websearch_to_tsquery('simple', query_text)
  order by rank desc
  limit greatest(match_count, 1);
$$;

-- ============================================================================
-- 0004: knowledge graph
-- ============================================================================
create table if not exists public.brain_entities (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  name_key   text not null unique,
  type       text not null default 'concept'
               check (type in ('person', 'place', 'thing', 'activity', 'concept')),
  created_at timestamptz not null default now()
);
create index if not exists brain_entities_name_key_idx on public.brain_entities (name_key);
alter table public.brain_entities enable row level security;
drop policy if exists brain_entities_no_anon on public.brain_entities;
create policy brain_entities_no_anon on public.brain_entities for all to anon using (false);

create table if not exists public.brain_edges (
  id          uuid primary key default gen_random_uuid(),
  from_entity uuid not null references public.brain_entities(id) on delete cascade,
  to_entity   uuid not null references public.brain_entities(id) on delete cascade,
  type        text not null default 'related',
  created_at  timestamptz default now(),
  unique (from_entity, to_entity, type)
);
create index if not exists brain_edges_from_entity_idx on public.brain_edges (from_entity);
create index if not exists brain_edges_to_entity_idx on public.brain_edges (to_entity);
alter table public.brain_edges enable row level security;
drop policy if exists brain_edges_no_anon on public.brain_edges;
create policy brain_edges_no_anon on public.brain_edges for all to anon using (false);

create table if not exists public.brain_memory_entities (
  id         uuid primary key default gen_random_uuid(),
  memory_id  uuid not null,
  entity_id  uuid not null references public.brain_entities(id) on delete cascade,
  created_at timestamptz default now(),
  unique (memory_id, entity_id)
);
create index if not exists brain_memory_entities_memory_id_idx
  on public.brain_memory_entities (memory_id);
alter table public.brain_memory_entities enable row level security;
drop policy if exists brain_memory_entities_no_anon on public.brain_memory_entities;
create policy brain_memory_entities_no_anon on public.brain_memory_entities for all to anon using (false);

-- ============================================================================
-- 0006: child profile
-- ============================================================================
create table if not exists public.brain_profile (
  id          uuid primary key default gen_random_uuid(),
  fact_key    text not null unique,
  fact_value  text not null,
  confidence  real not null default 0.6 check (confidence >= 0 and confidence <= 1),
  updated_at  timestamptz not null default now()
);
create index if not exists brain_profile_updated_at_desc on public.brain_profile (updated_at desc);
alter table public.brain_profile enable row level security;
drop policy if exists brain_profile_no_anon on public.brain_profile;
create policy brain_profile_no_anon on public.brain_profile for all to anon using (false);

-- ============================================================================
-- 0007: timeline / trajectory
-- ============================================================================
create table if not exists public.brain_events (
  id          uuid primary key default gen_random_uuid(),
  entity      text not null,
  kind        text not null default 'note'
                check (kind in ('milestone', 'feeling', 'activity', 'change', 'note')),
  summary     text not null check (length(summary) >= 1),
  occurred_at timestamptz not null default now(),
  created_at  timestamptz not null default now()
);
create index if not exists brain_events_entity_occurred_at_desc
  on public.brain_events (entity, occurred_at desc);
create index if not exists brain_events_occurred_at_desc
  on public.brain_events (occurred_at desc);
alter table public.brain_events enable row level security;
drop policy if exists brain_events_no_anon on public.brain_events;
create policy brain_events_no_anon on public.brain_events for all to anon using (false);

commit;
