/**
 * Shared domain types for the BMO Dashboard.
 *
 * Pure type-only file. No runtime logic, no imports beyond `type`-only ones.
 * Mirrors the Supabase schema in `supabase/schema.sql` and the configuration
 * shape used by the admin UI and the firmware-facing API routes.
 */

/** Soul / persona identifier. The dashboard ships with two stock souls. */
export type SoulName = 'doraemon' | 'bmo';

/** Configurable BMO capabilities surfaced as LLM tools. */
export type SkillName =
  | 'web_search'
  | 'sing'
  | 'play_music'
  | 'story'
  | 'comfort'
  | 'play_pretend';

/** Per-skill toggle plus optional opaque parameter bag. */
export interface SkillState {
  enabled: boolean;
  params?: Record<string, unknown>;
}

/**
 * The single row in the `config` table (id = 1).
 *
 * `fingerprint_hash` is an argon2id digest of the ESP32 fingerprint; the raw
 * fingerprint is never persisted server-side.
 */
export interface BmoConfig {
  soul_md: string;
  skills: Record<SkillName, SkillState>;
  fingerprint_hash: string;
  llm_model: string;
  stt_model: string;
  tts_model: string;
  tts_voice: string;
  /** Speaker volume on the device, 0–100. Pushed via `X-BMO-Volume`. */
  volume: number;
  updated_at: string;
}

/** The single row in the `admin` table (id = 1). */
export interface AdminRow {
  id: number;
  username: string;
  password_hash: string;
  created_at: string;
}

/** JWT payload for the admin session cookie (HS256, 24h TTL). */
export interface SessionPayload {
  username: string;
  /** Issued-at unix seconds. */
  iat: number;
}

/** A single row in the `activity_log` table. */
export interface ActivityLogEntry {
  id: number;
  created_at: string;
  type: 'stt' | 'tts' | 'brain';
  input_text: string | null;
  reply_text: string | null;
  model_stt: string | null;
  model_llm: string | null;
  model_tts: string | null;
  total_ms: number;
  status: 'ok' | 'error';
  error_stage: 'stt' | 'llm' | 'tts' | null;
  error_message: string | null;
}

/**
 * A row in the `songs` table.
 *
 * The catalog of MP3/OGG/WAV/FLAC/AAC URLs the operator wants BMO to be
 * able to play. The brain route exposes a `play_song` tool so the LLM can
 * pick one when the user asks for music. The audio is fetched from `url`
 * server-side, transcoded to PCM16 24 kHz mono, and streamed to the
 * firmware in the same wire format `/api/voice/tts` already uses.
 */
export interface Song {
  id: string;
  title: string;
  url: string;
  added_at: string;
}
