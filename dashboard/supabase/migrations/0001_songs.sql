-- Migration 0001: songs table.
--
-- BMO can play arbitrary audio files (MP3, OGG, WAV, FLAC, AAC) hosted at
-- HTTPS URLs the operator owns: a Cloudflare R2 bucket, an S3 bucket, a
-- static file server, etc. The dashboard stores a small catalog and the
-- brain route streams the bytes through a server-side ffmpeg transcode so
-- the firmware always receives the same PCM16 24 kHz mono format.
--
-- Run this in the Supabase SQL editor after schema.sql.

begin;

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
create policy songs_no_anon
  on public.songs
  for all
  to anon
  using (false);

commit;
