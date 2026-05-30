import 'server-only';

import { getServiceClient } from '@/lib/supabase-admin';
import type { BmoConfig, SkillName, SkillState } from '@/lib/types';

/**
 * ConfigService — typed reader/writer for the singleton `config` row.
 *
 * Hot paths (every `/api/brain` call) read this; we cache the row for 5
 * seconds per Vercel function instance to avoid hammering Supabase. Tests
 * and post-write code can force a refetch via `clearConfigCache()`.
 *
 * Validation (see {@link validateConfigPatch}) runs *before* any DB write.
 * `soul_md` is hard-capped at 64 KiB (65536 chars) per requirement 5.4.
 */

/** Per-instance cache TTL: 5 seconds, matching design Property 22 / 23. */
const CONFIG_CACHE_TTL_MS = 5_000;

/** Hard cap for soul_md, in UTF-16 code units (matches `string.length`). */
const SOUL_MD_MAX_BYTES = 65_536;

/** All recognized skill identifiers (mirrors `SkillName` in `lib/types.ts`). */
const SKILL_NAMES: readonly SkillName[] = [
  'web_search',
  'sing',
  'play_music',
  'story',
  'comfort',
  'play_pretend',
  'memory',
] as const;

const SKILL_NAME_SET: ReadonlySet<string> = new Set<string>(SKILL_NAMES);

const MODEL_FIELDS = ['llm_model', 'stt_model', 'tts_model', 'tts_voice'] as const;
type ModelField = (typeof MODEL_FIELDS)[number];

/** Thrown when a config patch fails structural / size validation. */
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

interface ConfigCache {
  value: BmoConfig;
  fetchedAt: number;
}

let cache: ConfigCache | null = null;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Hardcoded inline defaults used when the `config` row is missing. */
function makeDefaultRow(): Omit<BmoConfig, 'updated_at'> {
  return {
    soul_md: '',
    skills: {
      web_search: { enabled: true },
      sing: { enabled: true },
      play_music: { enabled: false },
      story: { enabled: true },
      comfort: { enabled: true },
      play_pretend: { enabled: true },
      memory: { enabled: true },
    },
    fingerprint_hash: '',
    llm_model: 'openai/gpt-4.1-mini',
    stt_model: 'qwen/qwen3-asr-flash-2026-02-10',
    tts_model: 'openai/gpt-audio-mini',
    tts_voice: 'fable',
    volume: 60,
  };
}

function coerceSkills(raw: unknown): Record<SkillName, SkillState> {
  const defaults = makeDefaultRow().skills;
  if (!isRecord(raw)) return defaults;
  const out: Record<SkillName, SkillState> = { ...defaults };
  for (const name of SKILL_NAMES) {
    const candidate = raw[name];
    if (isRecord(candidate) && typeof candidate.enabled === 'boolean') {
      const state: SkillState = { enabled: candidate.enabled };
      if (isRecord(candidate.params)) {
        state.params = candidate.params;
      }
      out[name] = state;
    }
  }
  return out;
}

function rowToConfig(row: unknown): BmoConfig {
  if (!isRecord(row)) {
    throw new Error('config row has unexpected shape');
  }
  const defaults = makeDefaultRow();
  let volume = defaults.volume;
  if (typeof row.volume === 'number' && Number.isFinite(row.volume)) {
    volume = Math.max(0, Math.min(100, Math.round(row.volume)));
  }
  return {
    soul_md: typeof row.soul_md === 'string' ? row.soul_md : defaults.soul_md,
    skills: coerceSkills(row.skills),
    fingerprint_hash:
      typeof row.fingerprint_hash === 'string' ? row.fingerprint_hash : defaults.fingerprint_hash,
    llm_model: typeof row.llm_model === 'string' ? row.llm_model : defaults.llm_model,
    stt_model: typeof row.stt_model === 'string' ? row.stt_model : defaults.stt_model,
    tts_model: typeof row.tts_model === 'string' ? row.tts_model : defaults.tts_model,
    tts_voice: typeof row.tts_voice === 'string' ? row.tts_voice : defaults.tts_voice,
    volume,
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : new Date().toISOString(),
  };
}

function validateConfigPatch(patch: Partial<BmoConfig>): void {
  if (patch.soul_md !== undefined) {
    if (typeof patch.soul_md !== 'string') {
      throw new ConfigValidationError('soul_md must be a string');
    }
    if (patch.soul_md.length > SOUL_MD_MAX_BYTES) {
      throw new ConfigValidationError(
        `soul_md exceeds ${SOUL_MD_MAX_BYTES} bytes (got ${patch.soul_md.length})`,
      );
    }
  }

  if (patch.skills !== undefined) {
    if (!isRecord(patch.skills)) {
      throw new ConfigValidationError('skills must be a record of SkillName to SkillState');
    }
    for (const [key, value] of Object.entries(patch.skills)) {
      if (!SKILL_NAME_SET.has(key)) {
        throw new ConfigValidationError(`skills contains unknown skill name "${key}"`);
      }
      if (!isRecord(value) || typeof value.enabled !== 'boolean') {
        throw new ConfigValidationError(
          `skills.${key} must be a SkillState ({ enabled: boolean, params?: object })`,
        );
      }
      if (value.params !== undefined && !isRecord(value.params)) {
        throw new ConfigValidationError(`skills.${key}.params must be an object when present`);
      }
    }
  }

  if (patch.fingerprint_hash !== undefined && typeof patch.fingerprint_hash !== 'string') {
    throw new ConfigValidationError('fingerprint_hash must be a string');
  }

  if (patch.volume !== undefined) {
    if (typeof patch.volume !== 'number' || !Number.isFinite(patch.volume)) {
      throw new ConfigValidationError('volume must be a finite number');
    }
    if (patch.volume < 0 || patch.volume > 100) {
      throw new ConfigValidationError('volume must be between 0 and 100');
    }
  }

  for (const field of MODEL_FIELDS) {
    const value: BmoConfig[ModelField] | undefined = patch[field];
    if (value !== undefined) {
      if (typeof value !== 'string' || value.length === 0) {
        throw new ConfigValidationError(`${field} must be a non-empty string`);
      }
    }
  }
}

/**
 * Returns the singleton config row. Cached for 5 seconds per function
 * instance. If the row does not exist (pre-onboarding), seeds it with
 * hardcoded defaults and returns the freshly-inserted row.
 */
export async function getConfig(): Promise<BmoConfig> {
  const now = Date.now();
  if (cache !== null && cache.fetchedAt + CONFIG_CACHE_TTL_MS > now) {
    return cache.value;
  }

  const supabase = getServiceClient();
  const selectResult = await supabase.from('config').select('*').eq('id', 1).maybeSingle();
  if (selectResult.error !== null) {
    throw new Error(`config select failed: ${selectResult.error.message}`);
  }

  let value: BmoConfig;
  if (selectResult.data === null) {
    const seed = { id: 1, ...makeDefaultRow() };
    const seedResult = await supabase
      .from('config')
      .upsert(seed, { onConflict: 'id' })
      .select('*')
      .single();
    if (seedResult.error !== null) {
      throw new Error(`config seed failed: ${seedResult.error.message}`);
    }
    value = rowToConfig(seedResult.data);
  } else {
    value = rowToConfig(selectResult.data);
  }

  cache = { value, fetchedAt: now };
  return value;
}

/**
 * Merges `patch` into the current config row, validates the merged result,
 * upserts, and clears the per-instance cache so the next read sees the new
 * value immediately.
 *
 * @throws {ConfigValidationError} if the patch fails structural validation
 *         (e.g. `soul_md` over 64 KiB).
 */
export async function updateConfig(patch: Partial<BmoConfig>): Promise<BmoConfig> {
  validateConfigPatch(patch);

  const current = await getConfig();
  const merged: BmoConfig = {
    ...current,
    ...patch,
    updated_at: new Date().toISOString(),
  };

  const supabase = getServiceClient();
  const writeResult = await supabase
    .from('config')
    .upsert(
      {
        id: 1,
        soul_md: merged.soul_md,
        skills: merged.skills,
        fingerprint_hash: merged.fingerprint_hash,
        llm_model: merged.llm_model,
        stt_model: merged.stt_model,
        tts_model: merged.tts_model,
        tts_voice: merged.tts_voice,
        volume: merged.volume,
        updated_at: merged.updated_at,
      },
      { onConflict: 'id' },
    )
    .select('*')
    .single();

  if (writeResult.error !== null) {
    throw new Error(`config upsert failed: ${writeResult.error.message}`);
  }

  clearConfigCache();
  const next = rowToConfig(writeResult.data);
  cache = { value: next, fetchedAt: Date.now() };
  return next;
}

/**
 * Forces the next `getConfig()` call to hit Supabase.
 *
 * Tests use this between assertions; production code (`updateConfig`) calls
 * it after every successful write so the new value is visible immediately
 * within the same request.
 */
export function clearConfigCache(): void {
  cache = null;
}
