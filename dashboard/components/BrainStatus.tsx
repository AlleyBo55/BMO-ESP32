'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Brain health + profile panel.
 *
 * Reads `/api/sim/brain-status` (the gbrain-style `diagnose()` + child
 * profile) and renders the rolled-up score, each individual check, and the
 * durable facts BMO has learned. This is the "is the brain actually wired
 * up?" surface — green checks mean migrations ran, embeddings flow, and the
 * recall RPC is live; red checks point at exactly what's missing.
 */

interface BrainCheck {
  id: string;
  ok: boolean;
  detail: string;
}

interface BrainHealth {
  score: number;
  checks: BrainCheck[];
  memoryCount: number;
  embeddedCount: number;
}

interface ProfileFact {
  key: string;
  value: string;
  confidence: number;
  updatedAt: string;
}

interface Snapshot {
  health: BrainHealth;
  profile: ProfileFact[];
}

function scoreColor(score: number): string {
  if (score >= 80) return 'text-emerald-400';
  if (score >= 40) return 'text-amber-400';
  return 'text-rose-400';
}

export default function BrainStatus(): React.ReactElement {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/sim/brain-status', { cache: 'no-store' });
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as Snapshot;
      setSnap(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Brain health (gbrain doctor)
        </h3>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 hover:border-sky-500 hover:text-sky-400 disabled:opacity-50"
        >
          {loading ? 'Checking…' : 'Re-check'}
        </button>
      </div>

      {error !== null ? (
        <p className="mt-3 text-sm text-rose-400">Couldn&apos;t read brain status: {error}</p>
      ) : snap === null ? (
        <p className="mt-3 text-sm text-zinc-500">Loading…</p>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="flex items-baseline gap-3">
            <span className={`text-3xl font-semibold ${scoreColor(snap.health.score)}`}>
              {snap.health.score}
            </span>
            <span className="text-xs text-zinc-500">
              / 100 · {snap.health.embeddedCount}/{snap.health.memoryCount} memories embedded
            </span>
          </div>

          <ul className="space-y-1.5">
            {snap.health.checks.map((c) => (
              <li key={c.id} className="flex items-start gap-2 text-xs">
                <span
                  className={`mt-0.5 inline-block h-2 w-2 shrink-0 rounded-full ${
                    c.ok ? 'bg-emerald-400' : 'bg-rose-400'
                  }`}
                />
                <span className="font-mono text-zinc-400">{c.id}</span>
                <span className="text-zinc-500">— {c.detail}</span>
              </li>
            ))}
          </ul>

          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              What BMO knows about the child
            </h4>
            {snap.profile.length === 0 ? (
              <p className="mt-2 text-xs text-zinc-600">
                Nothing learned yet. Facts accrue as you talk to BMO.
              </p>
            ) : (
              <ul className="mt-2 flex flex-wrap gap-2">
                {snap.profile.map((f) => (
                  <li
                    key={f.key}
                    className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs"
                    title={`confidence ${(f.confidence * 100).toFixed(0)}%`}
                  >
                    <span className="text-zinc-500">{f.key.replace(/_/g, ' ')}:</span>{' '}
                    <span className="text-zinc-200">{f.value}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
