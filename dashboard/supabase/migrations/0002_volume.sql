-- Migration 0002: per-device volume control.
--
-- Adds a `volume` column to the singleton config row. The dashboard exposes
-- the value through a slider on the Providers page; every firmware response
-- from /api/brain, /api/voice/tts, and /api/voice/song carries
-- `X-BMO-Volume: <0-100>` so the device picks up the new setting on the
-- next request without a separate config-poll endpoint.
--
-- Run in the Supabase SQL editor after schema.sql + 0001_songs.sql.

begin;

alter table public.config
  add column if not exists volume integer not null default 60
    check (volume between 0 and 100);

commit;
