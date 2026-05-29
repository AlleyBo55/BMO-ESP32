'use client';

import { useEffect, useState, useTransition } from 'react';

import CopyButton from '@/components/CopyButton';
import { rotateFingerprint } from '@/app/(admin)/fingerprint/actions';

/** How long the plaintext stays visible after a successful rotation. */
const REVEAL_TTL_MS = 60_000;

/** Fixed message shown after the reveal expires. */
const HIDDEN_MESSAGE = '(hidden — rotate again to view a new value)';

type Reveal =
  | { state: 'none' }
  | { state: 'visible'; value: string; expiresAt: number }
  | { state: 'expired' }
  | { state: 'error'; message: string };

/**
 * Client island for the fingerprint page.
 *
 * Renders the "Rotate" button, runs the server action, and reveals the
 * plaintext fingerprint exactly once. The plaintext auto-hides 60 seconds
 * after a successful rotation and is replaced with a "rotate again" hint.
 *
 * A red banner appears alongside any visible fingerprint reminding the admin
 * to re-flash the firmware before the device can reconnect.
 */
export default function FingerprintReveal(): React.ReactElement {
  const [reveal, setReveal] = useState<Reveal>({ state: 'none' });
  const [isPending, startTransition] = useTransition();

  // Auto-hide the plaintext after REVEAL_TTL_MS while it is visible.
  useEffect(() => {
    if (reveal.state !== 'visible') {
      return;
    }
    const remaining = reveal.expiresAt - Date.now();
    if (remaining <= 0) {
      setReveal({ state: 'expired' });
      return;
    }
    const handle = window.setTimeout(() => {
      setReveal({ state: 'expired' });
    }, remaining);
    return () => {
      window.clearTimeout(handle);
    };
  }, [reveal]);

  const handleRotate = (): void => {
    startTransition(async () => {
      const result = await rotateFingerprint();
      if (result.ok) {
        setReveal({
          state: 'visible',
          value: result.fingerprint,
          expiresAt: Date.now() + REVEAL_TTL_MS,
        });
      } else {
        setReveal({ state: 'error', message: result.error });
      }
    });
  };

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={handleRotate}
        disabled={isPending}
        className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? 'Rotating…' : 'Rotate fingerprint'}
      </button>

      {reveal.state === 'visible' ? (
        <RevealedPanel
          value={reveal.value}
          expiresAt={reveal.expiresAt}
        />
      ) : null}

      {reveal.state === 'expired' ? (
        <div className="rounded-md border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-300">
          {HIDDEN_MESSAGE}
        </div>
      ) : null}

      {reveal.state === 'error' ? (
        <div className="rounded-md border border-red-700 bg-red-950/40 px-4 py-3 text-sm text-red-200">
          Rotation failed: {reveal.message}
        </div>
      ) : null}
    </div>
  );
}

interface RevealedPanelProps {
  value: string;
  expiresAt: number;
}

function RevealedPanel({
  value,
  expiresAt,
}: RevealedPanelProps): React.ReactElement {
  const [secondsLeft, setSecondsLeft] = useState<number>(() =>
    Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)),
  );

  useEffect(() => {
    const handle = window.setInterval(() => {
      setSecondsLeft(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    }, 1000);
    return () => {
      window.clearInterval(handle);
    };
  }, [expiresAt]);

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-red-700 bg-red-950/40 px-4 py-3 text-sm text-red-200">
        ⚠️ Re-flash the BMO firmware with this new value before it can
        reconnect.
      </div>

      <div className="space-y-2 rounded-md border border-zinc-700 bg-zinc-900 p-4">
        <div className="flex items-center justify-between text-xs text-zinc-400">
          <span>New fingerprint (shown once)</span>
          <span>auto-hides in {secondsLeft}s</span>
        </div>
        <code className="block break-all rounded bg-zinc-950 px-3 py-2 font-mono text-sm text-emerald-300">
          {value}
        </code>
        <CopyButton text={value} />
      </div>
    </div>
  );
}
