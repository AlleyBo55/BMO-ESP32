'use server';

import {
  LLM_MODELS,
  STT_MODELS,
  TTS_MODELS,
  TTS_VOICES,
  isInList,
  type SaveProvidersInput,
} from './models';
import { updateConfig } from '@/lib/config';

/**
 * Persists the four provider selections to the singleton `config` row.
 *
 * Each value must appear in its corresponding allow-list; an out-of-list
 * value short-circuits with `{ ok: false }` and no DB write happens.
 *
 * Note: this file is `'use server'` and may only export async functions.
 * The allow-lists, types, and helpers live in `./models.ts` so they can
 * be imported by both the page (a server component) and the client
 * `<ProviderTester />` island.
 */
export async function saveProviders(
  input: SaveProvidersInput,
): Promise<{ ok: boolean }> {
  if (!isInList(input.llm_model, LLM_MODELS)) {
    return { ok: false };
  }
  if (!isInList(input.stt_model, STT_MODELS)) {
    return { ok: false };
  }
  if (!isInList(input.tts_model, TTS_MODELS)) {
    return { ok: false };
  }
  if (!isInList(input.tts_voice, TTS_VOICES)) {
    return { ok: false };
  }

  await updateConfig({
    llm_model: input.llm_model,
    stt_model: input.stt_model,
    tts_model: input.tts_model,
    tts_voice: input.tts_voice,
  });

  return { ok: true };
}

/**
 * Persists the speaker volume (0–100) to the singleton config row.
 * The firmware picks up the new value on its next request via
 * `X-BMO-Volume`.
 */
export async function saveVolume(
  volume: number,
): Promise<{ ok: boolean }> {
  if (
    typeof volume !== 'number' ||
    !Number.isFinite(volume) ||
    volume < 0 ||
    volume > 100
  ) {
    return { ok: false };
  }
  await updateConfig({ volume: Math.round(volume) });
  return { ok: true };
}
