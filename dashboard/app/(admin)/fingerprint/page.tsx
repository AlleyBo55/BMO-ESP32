import { getConfig } from '@/lib/config';

import FingerprintReveal from '@/components/FingerprintReveal';

/**
 * Fingerprint rotation page (server component).
 *
 * The dashboard stores only the argon2id hash of the fingerprint, so we
 * cannot reveal the configured value. This page therefore exposes only a
 * "configured ✓" status and a Rotate action; rotation generates a brand new
 * value, hashes it, persists the hash, and hands the plaintext back to the
 * client island for one-time display.
 */
export default async function FingerprintPage(): Promise<React.ReactElement> {
  const config = await getConfig();
  const isConfigured = config.fingerprint_hash.length > 0;

  return (
    <>
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">
          Fingerprint
        </h1>
        <p className="mt-1 text-sm text-zinc-400">
          The shared secret that lets the BMO firmware authenticate with this
          dashboard. Only the hash is stored, so the existing value cannot be
          revealed — rotate to generate a new one.
        </p>
      </header>

      <section className="space-y-6 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 sm:p-6">
        <div className="flex items-center gap-3 text-sm">
          <span className="font-medium text-zinc-200">Status:</span>
          {isConfigured ? (
            <span className="inline-flex items-center gap-1 rounded-md bg-emerald-950/60 px-2 py-1 text-xs font-medium text-emerald-300 ring-1 ring-inset ring-emerald-700/50">
              configured ✓
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-md bg-zinc-800 px-2 py-1 text-xs font-medium text-zinc-300 ring-1 ring-inset ring-zinc-700">
              not set
            </span>
          )}
        </div>

        <div className="rounded-md border border-amber-700/60 bg-amber-950/30 px-4 py-3 text-sm text-amber-200">
          Rotating the fingerprint immediately invalidates the old value.
          The BMO firmware must be re-flashed with the new fingerprint
          before it can talk to the dashboard again.
        </div>

        <FingerprintReveal />
      </section>
    </>
  );
}
