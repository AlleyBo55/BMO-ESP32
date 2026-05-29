'use client';

import { useState, useTransition } from 'react';

import {
  LLM_MODELS,
  STT_MODELS,
  TTS_MODELS,
  TTS_VOICES,
  type SaveProvidersInput,
} from '@/app/(admin)/providers/models';
import { saveProviders } from '@/app/(admin)/providers/actions';

/** Initial state for the form, supplied by the server component. */
export interface ProviderTesterProps {
  initial: SaveProvidersInput;
}

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  | { kind: 'error'; message: string };

type Toast = { id: number; message: string } | null;

/**
 * Client form for the providers page.
 *
 * Combines the four dropdowns (LLM / STT / TTS model + TTS voice) plus the
 * "Test STT" / "Test TTS" placeholder buttons. The save button calls the
 * `saveProviders` server action, which validates each value against the
 * allow-list before writing to the config row.
 */
export default function ProviderTester({
  initial,
}: ProviderTesterProps): React.ReactElement {
  const [llmModel, setLlmModel] = useState<string>(initial.llm_model);
  const [sttModel, setSttModel] = useState<string>(initial.stt_model);
  const [ttsModel, setTtsModel] = useState<string>(initial.tts_model);
  const [ttsVoice, setTtsVoice] = useState<string>(initial.tts_voice);

  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [isPending, startTransition] = useTransition();
  const [toast, setToast] = useState<Toast>(null);

  const showToast = (message: string): void => {
    const id = Date.now();
    setToast({ id, message });
    window.setTimeout(() => {
      setToast((current) => (current && current.id === id ? null : current));
    }, 3000);
  };

  const handleSave = (): void => {
    setSaveState({ kind: 'saving' });
    startTransition(async () => {
      try {
        const result = await saveProviders({
          llm_model: llmModel,
          stt_model: sttModel,
          tts_model: ttsModel,
          tts_voice: ttsVoice,
        });
        if (result.ok) {
          setSaveState({ kind: 'saved', at: Date.now() });
        } else {
          setSaveState({
            kind: 'error',
            message: 'One of the selected values is not allowed.',
          });
        }
      } catch (err) {
        setSaveState({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Save failed.',
        });
      }
    });
  };

  return (
    <div className="space-y-6">
      <Field
        label="LLM model"
        helper="Used by /api/brain to generate replies."
        value={llmModel}
        options={LLM_MODELS}
        onChange={setLlmModel}
        name="llm_model"
      />

      <Field
        label="STT model"
        helper="Used by /api/voice/stt and the audio path of /api/brain."
        value={sttModel}
        options={STT_MODELS}
        onChange={setSttModel}
        name="stt_model"
      />

      <Field
        label="TTS model"
        helper="Streams PCM16 audio back to the firmware."
        value={ttsModel}
        options={TTS_MODELS}
        onChange={setTtsModel}
        name="tts_model"
      />

      <Field
        label="TTS voice"
        helper="OpenAI voice preset for the TTS model."
        value={ttsVoice}
        options={TTS_VOICES}
        onChange={setTtsVoice}
        name="tts_voice"
      />

      <div className="flex flex-wrap items-center gap-3 pt-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={isPending}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPending ? 'Saving…' : 'Save'}
        </button>

        <button
          type="button"
          onClick={() => showToast('TODO: wire to API')}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-100 transition hover:bg-zinc-800"
        >
          Test STT
        </button>

        <button
          type="button"
          onClick={() => showToast('TODO: wire to API')}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-100 transition hover:bg-zinc-800"
        >
          Test TTS
        </button>

        <SaveBadge state={saveState} />
      </div>

      {toast !== null ? (
        <div
          role="status"
          aria-live="polite"
          className="fixed inset-x-4 bottom-4 z-50 rounded-md border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 shadow-lg sm:inset-x-auto sm:bottom-6 sm:right-6"
        >
          {toast.message}
        </div>
      ) : null}
    </div>
  );
}

interface FieldProps {
  label: string;
  helper: string;
  value: string;
  options: ReadonlyArray<string>;
  onChange: (next: string) => void;
  name: string;
}

function Field({
  label,
  helper,
  value,
  options,
  onChange,
  name,
}: FieldProps): React.ReactElement {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-zinc-200">{label}</span>
      <span className="mt-0.5 block text-xs text-zinc-500">{helper}</span>
      <select
        name={name}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 block w-full max-w-md rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function SaveBadge({ state }: { state: SaveState }): React.ReactElement | null {
  if (state.kind === 'idle' || state.kind === 'saving') {
    return null;
  }
  if (state.kind === 'saved') {
    return (
      <span className="text-xs text-emerald-400">
        Saved {new Date(state.at).toLocaleTimeString()}
      </span>
    );
  }
  return <span className="text-xs text-red-400">{state.message}</span>;
}
