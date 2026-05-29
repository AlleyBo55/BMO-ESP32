import { getConfig } from '@/lib/config';

import ProviderTester from '@/components/ProviderTester';
import VolumeSlider from '@/components/VolumeSlider';
import {
  LLM_MODELS,
  STT_MODELS,
  TTS_MODELS,
  TTS_VOICES,
} from './models';

/**
 * Providers page (server component).
 *
 * Reads the current `config` row, then hands the four selections to a small
 * client island (`ProviderTester`) that lets the admin pick from the
 * hardcoded allow-lists. The "Test STT" / "Test TTS" buttons are placeholders
 * for now and just surface a toast — they'll be wired to real round-trip
 * tests in a later task.
 */
export default async function ProvidersPage(): Promise<React.ReactElement> {
  const config = await getConfig();

  // Fall back to the first option of each list if the stored value somehow
  // drifted out of the allow-list (e.g. an admin hand-edited Supabase). The
  // server action will reject any out-of-list save, so this just keeps the
  // UI in a consistent state.
  const initialLlm = (LLM_MODELS as ReadonlyArray<string>).includes(
    config.llm_model,
  )
    ? config.llm_model
    : LLM_MODELS[0];
  const initialStt = (STT_MODELS as ReadonlyArray<string>).includes(
    config.stt_model,
  )
    ? config.stt_model
    : STT_MODELS[0];
  const initialTts = (TTS_MODELS as ReadonlyArray<string>).includes(
    config.tts_model,
  )
    ? config.tts_model
    : TTS_MODELS[0];
  const initialVoice = (TTS_VOICES as ReadonlyArray<string>).includes(
    config.tts_voice,
  )
    ? config.tts_voice
    : TTS_VOICES[0];

  return (
    <>
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">
          Providers
        </h1>
        <p className="mt-1 text-sm text-zinc-400">
          Pick the OpenRouter models and TTS voice that BMO will use.
        </p>
      </header>

      <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 sm:p-6">
        <ProviderTester
          initial={{
            llm_model: initialLlm,
            stt_model: initialStt,
            tts_model: initialTts,
            tts_voice: initialVoice,
          }}
        />
      </section>

      <section className="mt-6 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 sm:p-6">
        <VolumeSlider initialVolume={config.volume} />
      </section>
    </>
  );
}
