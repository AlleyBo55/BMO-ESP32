-- BMO Dashboard — Supabase Schema
--
-- Run this in the Supabase SQL editor against a fresh project.
-- After this file, run seed.sql to insert the default config row.
--
-- Design contract (see ../docs/SUPABASE-SETUP.md and design.md):
--   * Four tables: admin, config, activity_log, auth_attempts
--   * admin and config are singletons enforced via `check (id = 1)`
--   * All four tables enable row-level security
--   * All four block the anon key entirely; only the service-role key reads/writes
--   * activity_log indexed on (created_at desc) for fast recent-activity reads
--   * auth_attempts indexed on (username, attempted_at desc) for lockout checks

begin;

-- ----------------------------------------------------------------------------
-- admin: singleton row created exactly once at onboarding.
-- ----------------------------------------------------------------------------
create table if not exists public.admin (
  id            integer primary key default 1 check (id = 1),
  username      text not null unique,
  password_hash text not null,
  created_at    timestamptz not null default now()
);

alter table public.admin enable row level security;

drop policy if exists admin_no_anon on public.admin;
create policy admin_no_anon
  on public.admin
  for all
  to anon
  using (false);

-- ----------------------------------------------------------------------------
-- config: singleton row holding soul, skills, fingerprint hash, model picks.
-- fingerprint_hash defaults to '' so that this row can be seeded before
-- onboarding completes; the onboarding flow rewrites it with an argon2id hash.
-- ----------------------------------------------------------------------------
create table if not exists public.config (
  id               integer primary key default 1 check (id = 1),
  soul_md          text        not null default '',
  skills           jsonb       not null default '{}'::jsonb,
  fingerprint_hash text        not null default '',
  llm_model        text        not null default 'openai/gpt-4.1-mini',
  stt_model        text        not null default 'qwen/qwen3-asr-flash-2026-02-10',
  tts_model        text        not null default 'openai/gpt-audio-mini',
  tts_voice        text        not null default 'fable',
  volume           integer     not null default 60 check (volume between 0 and 100),
  updated_at       timestamptz not null default now()
);

alter table public.config enable row level security;

drop policy if exists config_no_anon on public.config;
create policy config_no_anon
  on public.config
  for all
  to anon
  using (false);

-- ----------------------------------------------------------------------------
-- activity_log: append-only record of every API request that passes the
-- fingerprint guard. One row per request, written in a `finally` block.
-- ----------------------------------------------------------------------------
create table if not exists public.activity_log (
  id            bigserial primary key,
  created_at    timestamptz not null default now(),
  type          text        not null check (type in ('stt', 'tts', 'brain')),
  input_text    text,
  reply_text    text,
  model_stt     text,
  model_llm     text,
  model_tts     text,
  total_ms      integer     not null,
  status        text        not null check (status in ('ok', 'error')),
  error_stage   text        check (error_stage in ('stt', 'llm', 'tts')),
  error_message text
);

create index if not exists activity_log_created_at_desc
  on public.activity_log (created_at desc);

alter table public.activity_log enable row level security;

drop policy if exists activity_log_no_anon on public.activity_log;
create policy activity_log_no_anon
  on public.activity_log
  for all
  to anon
  using (false);

-- ----------------------------------------------------------------------------
-- auth_attempts: rolling 15-minute window of failed logins, used by the
-- lockout check in lib/auth.ts. Cleared on successful login.
-- ----------------------------------------------------------------------------
create table if not exists public.auth_attempts (
  id           bigserial primary key,
  username     text not null,
  attempted_at timestamptz not null default now()
);

create index if not exists auth_attempts_username_time
  on public.auth_attempts (username, attempted_at desc);

alter table public.auth_attempts enable row level security;

drop policy if exists auth_attempts_no_anon on public.auth_attempts;
create policy auth_attempts_no_anon
  on public.auth_attempts
  for all
  to anon
  using (false);

-- ----------------------------------------------------------------------------
-- brain_memory: BMO's persistent, self-growing memory (the "gbrain layer").
-- Every conversational exchange is captured here with an OpenRouter
-- embedding; the brain route recalls the most relevant rows before each
-- reply. See migrations/0003_brain_memory.sql and lib/brain.ts for the full
-- rationale and the migration path to a real gbrain daemon.
-- ----------------------------------------------------------------------------
create extension if not exists vector;

create table if not exists public.brain_memory (
  id          uuid primary key default gen_random_uuid(),
  kind        text        not null default 'conversation'
                check (kind in ('conversation', 'fact', 'note')),
  content     text        not null check (length(content) >= 1),
  embedding   vector(1536),
  -- Salience + access bookkeeping (migration 0005): consolidation/dream-cycle
  -- signals so the brain can boost, decay, or prune memories on merit.
  salience         real        not null default 0.5,
  last_accessed_at timestamptz,
  access_count     integer     not null default 0,
  -- Full-text channel (migration 0008): generated tsvector for hybrid search.
  content_tsv tsvector generated always as (to_tsvector('simple', coalesce(content, ''))) stored,
  created_at  timestamptz not null default now()
);

create index if not exists brain_memory_embedding_idx
  on public.brain_memory
  using hnsw (embedding vector_cosine_ops);

create index if not exists brain_memory_created_at_desc
  on public.brain_memory (created_at desc);

create index if not exists brain_memory_salience_desc
  on public.brain_memory (salience desc);

create index if not exists brain_memory_tsv_idx
  on public.brain_memory using gin (content_tsv);

alter table public.brain_memory enable row level security;

drop policy if exists brain_memory_no_anon on public.brain_memory;
create policy brain_memory_no_anon
  on public.brain_memory
  for all
  to anon
  using (false);

create or replace function public.match_brain_memory(
  query_embedding vector(1536),
  match_count     int   default 5,
  min_similarity  float default 0.0
)
returns table (
  id         uuid,
  kind       text,
  content    text,
  created_at timestamptz,
  similarity float
)
language sql
stable
as $$
  select
    m.id,
    m.kind,
    m.content,
    m.created_at,
    1 - (m.embedding <=> query_embedding) as similarity
  from public.brain_memory m
  where m.embedding is not null
    and 1 - (m.embedding <=> query_embedding) >= min_similarity
  order by m.embedding <=> query_embedding
  limit greatest(match_count, 1);
$$;

-- ----------------------------------------------------------------------------
-- Brain core extensions (migrations 0004–0008). These build the full
-- "gbrain layer": self-wiring knowledge graph, dedup, child profile,
-- timeline/trajectory, and hybrid keyword search. All additive; all RLS-on,
-- anon-blocked. See supabase/migrations/000{4..8}_*.sql for the rationale.
-- ----------------------------------------------------------------------------

-- --- knowledge graph (0004) ------------------------------------------------
create table if not exists public.brain_entities (
  id         uuid        primary key default gen_random_uuid(),
  name       text        not null,
  name_key   text        not null unique,
  type       text        not null default 'concept'
               check (type in ('person', 'place', 'thing', 'activity', 'concept')),
  created_at timestamptz not null default now()
);
create index if not exists brain_entities_name_key_idx on public.brain_entities (name_key);
alter table public.brain_entities enable row level security;
drop policy if exists brain_entities_no_anon on public.brain_entities;
create policy brain_entities_no_anon on public.brain_entities for all to anon using (false);

create table if not exists public.brain_edges (
  id          uuid        primary key default gen_random_uuid(),
  from_entity uuid        not null references public.brain_entities(id) on delete cascade,
  to_entity   uuid        not null references public.brain_entities(id) on delete cascade,
  type        text        not null default 'related',
  created_at  timestamptz default now(),
  unique (from_entity, to_entity, type)
);
create index if not exists brain_edges_from_entity_idx on public.brain_edges (from_entity);
create index if not exists brain_edges_to_entity_idx on public.brain_edges (to_entity);
alter table public.brain_edges enable row level security;
drop policy if exists brain_edges_no_anon on public.brain_edges;
create policy brain_edges_no_anon on public.brain_edges for all to anon using (false);

create table if not exists public.brain_memory_entities (
  id         uuid        primary key default gen_random_uuid(),
  memory_id  uuid        not null,
  entity_id  uuid        not null references public.brain_entities(id) on delete cascade,
  created_at timestamptz default now(),
  unique (memory_id, entity_id)
);
create index if not exists brain_memory_entities_memory_id_idx on public.brain_memory_entities (memory_id);
alter table public.brain_memory_entities enable row level security;
drop policy if exists brain_memory_entities_no_anon on public.brain_memory_entities;
create policy brain_memory_entities_no_anon on public.brain_memory_entities for all to anon using (false);

-- --- dedup RPC (0005) ------------------------------------------------------
create or replace function public.find_duplicate_memories(
  similarity_threshold float default 0.95,
  max_pairs            int   default 100
)
returns table (keep_id uuid, drop_id uuid, similarity float)
language sql
stable
as $$
  select
    case when a.created_at <= b.created_at then a.id else b.id end as keep_id,
    case when a.created_at <= b.created_at then b.id else a.id end as drop_id,
    1 - (a.embedding <=> b.embedding) as similarity
  from public.brain_memory a
  join public.brain_memory b on a.id < b.id
  where a.embedding is not null
    and b.embedding is not null
    and 1 - (a.embedding <=> b.embedding) >= similarity_threshold
  order by similarity desc
  limit greatest(max_pairs, 1);
$$;

-- --- child profile (0006) --------------------------------------------------
create table if not exists public.brain_profile (
  id          uuid        primary key default gen_random_uuid(),
  fact_key    text        not null unique,
  fact_value  text        not null,
  confidence  real        not null default 0.6 check (confidence >= 0 and confidence <= 1),
  updated_at  timestamptz not null default now()
);
create index if not exists brain_profile_updated_at_desc on public.brain_profile (updated_at desc);
alter table public.brain_profile enable row level security;
drop policy if exists brain_profile_no_anon on public.brain_profile;
create policy brain_profile_no_anon on public.brain_profile for all to anon using (false);

-- --- timeline / trajectory (0007) ------------------------------------------
create table if not exists public.brain_events (
  id          uuid        primary key default gen_random_uuid(),
  entity      text        not null,
  kind        text        not null default 'note'
                check (kind in ('milestone', 'feeling', 'activity', 'change', 'note')),
  summary     text        not null check (length(summary) >= 1),
  occurred_at timestamptz not null default now(),
  created_at  timestamptz not null default now()
);
create index if not exists brain_events_entity_occurred_at_desc on public.brain_events (entity, occurred_at desc);
create index if not exists brain_events_occurred_at_desc on public.brain_events (occurred_at desc);
alter table public.brain_events enable row level security;
drop policy if exists brain_events_no_anon on public.brain_events;
create policy brain_events_no_anon on public.brain_events for all to anon using (false);

-- --- hybrid keyword search RPC (0008) --------------------------------------
create or replace function public.keyword_search_memory(
  query_text  text,
  match_count int default 10
)
returns table (id uuid, kind text, content text, created_at timestamptz, rank real)
language sql
stable
as $$
  select
    m.id,
    m.kind,
    m.content,
    m.created_at,
    ts_rank(m.content_tsv, websearch_to_tsquery('simple', query_text)) as rank
  from public.brain_memory m
  where btrim(coalesce(query_text, '')) <> ''
    and m.content_tsv @@ websearch_to_tsquery('simple', query_text)
  order by rank desc
  limit greatest(match_count, 1);
$$;

commit;
