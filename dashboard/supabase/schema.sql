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
  tts_voice        text        not null default 'nova',
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

commit;
