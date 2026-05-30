'use client';

import { useEffect, useState } from 'react';

/**
 * Live OpenRouter credits display.
 *
 * Renders a horizontal usage bar plus the three numbers (remaining / used /
 * total) in USD. Polls `/api/openrouter/credits` every 60 seconds via
 * `setInterval` and updates in place. If a poll fails or the upstream
 * returned a `stale: true` marker, a small "stale" badge appears.
 *
 * The parent server component (`app/(admin)/page.tsx`) seeds `initialData`
 * with the freshest server-side fetch so the first paint is never empty.
 */

export interface CreditsSnapshot {
  total: number;
  used: number;
  remaining: number;
  currency: 'USD';
}

export interface CreditsApiResponse extends CreditsSnapshot {
  stale?: boolean;
}

interface CreditsLiveProps {
  initialData: CreditsSnapshot | null;
  /** Initial stale state (true if the server-side seed fetch failed). */
  initialStale?: boolean;
}

const POLL_INTERVAL_MS = 60_000;

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `$${value.toFixed(2)}`;
}

function pctUsed(snap: CreditsSnapshot): number {
  if (snap.total <= 0) return 0;
  const ratio = snap.used / snap.total;
  if (!Number.isFinite(ratio)) return 0;
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

export default function CreditsLive({
  initialData,
  initialStale = false,
}: CreditsLiveProps): React.ReactElement {
  const [snapshot, setSnapshot] = useState<CreditsSnapshot | null>(initialData);
  const [stale, setStale] = useState<boolean>(initialStale);

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();

    const fetchOnce = async (): Promise<void> => {
      try {
        const response = await fetch('/api/openrouter/credits', {
          method: 'GET',
          signal: ac.signal,
          cache: 'no-store',
        });
        if (!response.ok) {
          if (!cancelled) setStale(true);
          return;
        }
        const data = (await response.json()) as CreditsApiResponse;
        if (cancelled) return;
        setSnapshot({
          total: data.total,
          used: data.used,
          remaining: data.remaining,
          currency: data.currency,
        });
        setStale(data.stale === true);
      } catch {
        if (!cancelled) setStale(true);
      }
    };

    // Fetch immediately on mount so the card fills in without waiting a full
    // poll interval. The server no longer blocks its render on the OpenRouter
    // call, so this client-side fetch is what populates the numbers. The
    // `/api/openrouter/credits` route memoizes upstream for 30s per instance,
    // so this stays cheap even across navigations.
    void fetchOnce();

    const timer = setInterval(() => {
      void fetchOnce();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      ac.abort();
      clearInterval(timer);
    };
  }, []);

  if (snapshot === null) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-300">OpenRouter credits</h2>
          {stale ? (
            <span className="text-xs text-amber-400">stale</span>
          ) : (
            <span className="text-xs text-zinc-500">loading…</span>
          )}
        </div>
        <p className="mt-3 text-sm text-zinc-500">
          {stale
            ? 'No credit data available. Check OPENROUTER_API_KEY and try again.'
            : 'Fetching balance…'}
        </p>
      </div>
    );
  }

  const used = pctUsed(snapshot);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-zinc-300">OpenRouter credits</h2>
        {stale ? (
          <span
            className="rounded bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-400"
            title="Last refresh failed; showing previous values."
          >
            stale
          </span>
        ) : null}
      </div>

      <div className="mt-4 flex items-baseline gap-2">
        <span className="text-3xl font-semibold text-sky-400">
          {formatUsd(snapshot.remaining)}
        </span>
        <span className="text-xs text-zinc-500">remaining</span>
      </div>

      <div className="mt-4 h-2 w-full overflow-hidden rounded bg-zinc-800">
        <div
          className="h-full bg-sky-500 transition-all"
          style={{ width: `${used}%` }}
          aria-label={`${used}% used`}
        />
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs text-zinc-400">
        <div className="flex justify-between">
          <dt>Used</dt>
          <dd className="font-mono text-zinc-200">{formatUsd(snapshot.used)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Total</dt>
          <dd className="font-mono text-zinc-200">{formatUsd(snapshot.total)}</dd>
        </div>
      </dl>
    </div>
  );
}
