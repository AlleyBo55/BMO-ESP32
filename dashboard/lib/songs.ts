import 'server-only';

import { getServiceClient } from '@/lib/supabase-admin';
import type { Song } from '@/lib/types';

/**
 * Songs catalog — typed CRUD over the `songs` table.
 *
 * The dashboard lets the operator add/remove rows; the firmware-facing
 * routes (`/api/voice/song`, `/api/brain`) read them. Every URL must be
 * `https://` — the schema has a CHECK constraint for that, but we also
 * validate at the application layer for nicer error messages.
 *
 * The list of titles is also exposed to the LLM as the `enum` of a
 * `play_song` tool so the model can pick one when the user asks for music.
 */

const TITLE_MIN = 1;
const TITLE_MAX = 200;
const URL_MAX = 2_048;

export class SongValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SongValidationError';
  }
}

function isHttpsUrl(value: string): boolean {
  if (value.length === 0 || value.length > URL_MAX) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateTitle(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < TITLE_MIN) {
    throw new SongValidationError('title must not be empty');
  }
  if (trimmed.length > TITLE_MAX) {
    throw new SongValidationError(`title exceeds ${TITLE_MAX} characters`);
  }
  return trimmed;
}

function validateUrl(value: string): string {
  const trimmed = value.trim();
  if (!isHttpsUrl(trimmed)) {
    throw new SongValidationError('url must be a valid https:// URL');
  }
  return trimmed;
}

function rowToSong(row: unknown): Song {
  if (typeof row !== 'object' || row === null) {
    throw new Error('songs row has unexpected shape');
  }
  const r = row as Record<string, unknown>;
  return {
    id: typeof r.id === 'string' ? r.id : '',
    title: typeof r.title === 'string' ? r.title : '',
    url: typeof r.url === 'string' ? r.url : '',
    added_at:
      typeof r.added_at === 'string' ? r.added_at : new Date().toISOString(),
  };
}

/** Lists every song, newest first. */
export async function listSongs(): Promise<Song[]> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('songs')
    .select('*')
    .order('added_at', { ascending: false });
  if (error !== null) {
    throw new Error(`listSongs failed: ${error.message}`);
  }
  if (!Array.isArray(data)) return [];
  return data.map(rowToSong);
}

/** Fetches a single song by id, or null when missing. */
export async function getSong(id: string): Promise<Song | null> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('songs')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error !== null) {
    throw new Error(`getSong failed: ${error.message}`);
  }
  return data === null ? null : rowToSong(data);
}

/**
 * Looks up a song by its (case-insensitive) title. The LLM gets a tool
 * whose `enum` is the list of titles; when it calls the tool with one of
 * them we resolve it back to a row id here.
 */
export async function findSongByTitle(title: string): Promise<Song | null> {
  const trimmed = title.trim();
  if (trimmed.length === 0) return null;
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('songs')
    .select('*')
    .ilike('title', trimmed)
    .limit(1)
    .maybeSingle();
  if (error !== null) {
    throw new Error(`findSongByTitle failed: ${error.message}`);
  }
  return data === null ? null : rowToSong(data);
}

/** Inserts a new song. Validates and trims `title` and `url`. */
export async function addSong(input: {
  title: string;
  url: string;
}): Promise<Song> {
  const title = validateTitle(input.title);
  const url = validateUrl(input.url);
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('songs')
    .insert({ title, url })
    .select('*')
    .single();
  if (error !== null) {
    throw new Error(`addSong failed: ${error.message}`);
  }
  return rowToSong(data);
}

/** Deletes a song by id. Returns whether a row was actually removed. */
export async function deleteSong(id: string): Promise<boolean> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('songs')
    .delete()
    .eq('id', id)
    .select('id');
  if (error !== null) {
    throw new Error(`deleteSong failed: ${error.message}`);
  }
  return Array.isArray(data) && data.length > 0;
}
