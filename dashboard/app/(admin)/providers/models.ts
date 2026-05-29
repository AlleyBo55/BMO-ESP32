/**
 * Provider model + voice allow-lists.
 *
 * Hardcoded canonical options used both for rendering the dropdowns and for
 * validating any submitted value before it touches the database. Kept in a
 * plain module (no `'use server'`) because Next.js requires `'use server'`
 * files to export only async functions; constant arrays would crash the
 * build with "A 'use server' file can only export async functions, found
 * object."
 */

export const LLM_MODELS = [
  'openai/gpt-4.1-mini',
  'openai/gpt-4o-mini',
  'anthropic/claude-haiku-4-5',
  'anthropic/claude-opus-4-6',
  'qwen/qwen3-235b-a22b-2507',
] as const;

export const STT_MODELS = [
  'qwen/qwen3-asr-flash-2026-02-10',
  'openai/whisper-large-v3',
] as const;

export const TTS_MODELS = [
  'openai/gpt-audio-mini',
  'openai/gpt-audio',
] as const;

export const TTS_VOICES = [
  'nova',
  'alloy',
  'echo',
  'shimmer',
  'onyx',
  'fable',
  'sage',
  'coral',
] as const;

export type LlmModel = (typeof LLM_MODELS)[number];
export type SttModel = (typeof STT_MODELS)[number];
export type TtsModel = (typeof TTS_MODELS)[number];
export type TtsVoice = (typeof TTS_VOICES)[number];

export interface SaveProvidersInput {
  llm_model: string;
  stt_model: string;
  tts_model: string;
  tts_voice: string;
}

export function isInList<T extends string>(
  value: string,
  list: ReadonlyArray<T>,
): value is T {
  return (list as ReadonlyArray<string>).includes(value);
}
