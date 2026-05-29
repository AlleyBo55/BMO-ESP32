'use client';

import { useState, useTransition } from 'react';

import { saveVolume } from '@/app/(admin)/providers/actions';

/**
 * Speaker-volume slider.
 *
 * Sits on the Providers page alongside the model dropdowns. Live state lives
 * in this component; on commit (debounced or onMouseUp) it calls the
 * `saveVolume` server action which writes the value to the singleton config
 * row. The firmware picks up the new value on the next request via the
 * `X-BMO-Volume` response header — no separate config-poll endpoint.
 */

export interface VolumeSliderProps {
  initialVolume: number;
}

type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  | { kind: 'error'; message: string };

export default function VolumeSlider({
  initialVolume,
}: VolumeSliderProps): React.ReactElement {
  const [volume, setVolume] = useState<number>(
    Math.max(0, Math.min(100, Math.round(initialVolume))),
  );
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle' });
  const [isPending, startTransition] = useTransition();

  const commit = (next: number): void => {
    const clamped = Math.max(0, Math.min(100, Math.round(next)));
    if (clamped === initialVolume && status.kind === 'idle') {
      // Nothing to do.
      return;
    }
    setStatus({ kind: 'saving' });
    startTransition(async () => {
      try {
        const result = await saveVolume(clamped);
        if (result.ok) {
          setStatus({ kind: 'saved', at: Date.now() });
        } else {
          setStatus({
            kind: 'error',
            message: 'Volume must be between 0 and 100.',
          });
        }
      } catch (err) {
        setStatus({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Save failed.',
        });
      }
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-zinc-200">Speaker volume</span>
        <span className="font-mono text-sm text-zinc-100">{volume}</span>
      </div>
      <p className="text-xs text-zinc-500">
        Pushed to the BMO device on every response via{' '}
        <code className="rounded bg-zinc-800 px-1 py-0.5 text-[11px]">
          X-BMO-Volume
        </code>
        . Default 60.
      </p>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={volume}
        onChange={(event) => setVolume(Number.parseInt(event.target.value, 10))}
        onMouseUp={() => commit(volume)}
        onTouchEnd={() => commit(volume)}
        onKeyUp={() => commit(volume)}
        disabled={isPending}
        aria-label="Speaker volume"
        className="block w-full accent-emerald-500 disabled:opacity-50"
      />
      <div className="flex items-center gap-2 text-xs">
        {status.kind === 'saving' ? (
          <span className="text-zinc-400">Saving…</span>
        ) : null}
        {status.kind === 'saved' ? (
          <span className="text-emerald-400">
            Saved {new Date(status.at).toLocaleTimeString()}
          </span>
        ) : null}
        {status.kind === 'error' ? (
          <span className="text-rose-400">{status.message}</span>
        ) : null}
      </div>
    </div>
  );
}
