-- Migration 0003: brain_memory — BMO's persistent, self-growing memory.
--
-- This is the "gbrain-shaped" brain layer, built on the stack BMO already
-- has (Supabase + OpenRouter) instead of a separate gbrain daemon. The real
-- gbrain (https://github.com/garrytan/gbrain) is a stateful daemon with its
-- own Postgres, a 24/7 cron "dream cycle", and an MCP server — none of which
-- can run inside Vercel's stateless functions. So we reproduce its three
-- load-bearing ideas here:
--
--   1. Persistent memory   — every exchange is written down (capture).
--   2. Brain-first recall  — before answering, look up what BMO already
--                            knows via semantic (vector) search (recall).
--   3. Auto-grow           — the brain gets richer the more BMO is used.
--
-- When you later stand up the real gbrain on a VPS, only `lib/brain.ts`
-- changes (it starts calling the daemon over HTTPS); this table and the
-- firmware stay exactly as they are.
--
-- Embeddings: OpenAI text-embedding-3-small via OpenRouter, pinned to 1536
-- dimensions. Changing the embedding model to one with a different
-- dimensionality requires altering the column below and re-embedding.
--
-- Run this in the Supabase SQL editor after 0002_volume.sql.

begin;

-- pgvector ships with Supabase; this is idempotent.
create extension if not exists vector;

create table if not exists public.brain_memory (
  id          uuid primary key default gen_random_uuid(),
  -- Coarse classification of the memory. 'conversation' for captured
  -- dialogue turns; 'fact' / 'note' reserved for operator-authored or
  -- future enrichment-authored entries.
  kind        text        not null default 'conversation'
                check (kind in ('conversation', 'fact', 'note')),
  content     text        not null check (length(content) >= 1),
  embedding   vector(1536),
  created_at  timestamptz not null default now()
);

-- Approximate-nearest-neighbour index for fast cosine similarity recall.
create index if not exists brain_memory_embedding_idx
  on public.brain_memory
  using hnsw (embedding vector_cosine_ops);

create index if not exists brain_memory_created_at_desc
  on public.brain_memory (created_at desc);

alter table public.brain_memory enable row level security;

-- Same posture as every other table: the anon key can touch nothing; only
-- the server-side service-role key reads and writes.
drop policy if exists brain_memory_no_anon on public.brain_memory;
create policy brain_memory_no_anon
  on public.brain_memory
  for all
  to anon
  using (false);

-- ----------------------------------------------------------------------------
-- match_brain_memory: cosine-similarity recall.
--
-- Returns the `match_count` most similar memories whose similarity is at
-- least `min_similarity` (0..1, where 1 is identical). Similarity is
-- 1 - cosine_distance so a plain `>=` threshold reads naturally.
-- ----------------------------------------------------------------------------
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

commit;
