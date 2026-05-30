-- Migration 0008: brain hybrid search — full-text (BM25-style) retrieval.
--
-- This migration gives BMO's "gbrain layer" its second retrieval channel.
-- 0003_brain_memory.sql added semantic (vector) recall via pgvector and the
-- `match_brain_memory` RPC. Vector search is great at meaning but blind to
-- exact tokens: a query for a rare proper noun, a code, or an uncommon word
-- can rank poorly if the surrounding phrasing differs from what was stored.
--
-- Lexical full-text search has the opposite strengths — it nails exact
-- keyword hits but misses paraphrase. The sibling `lib/brain/search.ts`
-- module fuses both channels with Reciprocal Rank Fusion (RRF) so the two
-- retrievers cover each other's blind spots. This migration supplies the
-- lexical half:
--
--   1. A generated `content_tsv` tsvector column derived from `content`,
--      kept in sync automatically by Postgres (no triggers to maintain).
--   2. A GIN index over that column for fast full-text matching.
--   3. `keyword_search_memory` — a ts_rank-ordered keyword recall RPC that
--      mirrors the shape of `match_brain_memory`.
--
-- The 'simple' text-search configuration is used (matching the stored
-- column) so retrieval is language-agnostic: it lower-cases and tokenizes
-- without stemming or a stopword list, which suits BMO's mixed
-- Indonesian/English conversational memory better than a single-language
-- stemmer would.
--
-- Run this in the Supabase SQL editor after 0004_brain_graph.sql.

begin;

-- ----------------------------------------------------------------------------
-- content_tsv: a stored, generated full-text vector over `content`.
--
-- GENERATED ALWAYS ... STORED means Postgres recomputes and persists this on
-- every insert/update of `content`, so it can never drift from the source
-- text and needs no trigger. `coalesce(content,'')` guards the (impossible
-- per the table's NOT NULL check, but defensive) null case.
-- ----------------------------------------------------------------------------
alter table public.brain_memory
  add column if not exists content_tsv tsvector
    generated always as (to_tsvector('simple', coalesce(content, ''))) stored;

-- GIN is the standard index type for tsvector containment queries.
create index if not exists brain_memory_tsv_idx
  on public.brain_memory
  using gin (content_tsv);

-- ----------------------------------------------------------------------------
-- keyword_search_memory: lexical (full-text) recall.
--
-- Parses `query_text` with websearch_to_tsquery (which understands quoted
-- phrases, OR, and - exclusion like a search box), matches it against the
-- generated content_tsv, and returns the `match_count` best rows ordered by
-- ts_rank descending. The shape mirrors match_brain_memory so the caller can
-- fuse the two result lists symmetrically.
--
-- Empty / blank queries short-circuit to no rows: websearch_to_tsquery on a
-- blank string yields an empty tsquery that matches everything at rank 0,
-- which would be noise, so we guard explicitly.
-- ----------------------------------------------------------------------------
create or replace function public.keyword_search_memory(
  query_text  text,
  match_count int default 10
)
returns table (
  id         uuid,
  kind       text,
  content    text,
  created_at timestamptz,
  rank       real
)
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
