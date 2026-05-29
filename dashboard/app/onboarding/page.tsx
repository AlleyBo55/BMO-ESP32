'use client';

import { useState, useTransition } from 'react';
import type { FormEvent, ReactElement } from 'react';

import { createAdmin, type OnboardingResult } from './actions';

/**
 * First-run onboarding wizard.
 *
 * Collects username, password, and (optionally) the ESP32 fingerprint, then
 * dispatches the `createAdmin` server action through `useTransition`. On
 * success the page swaps to a one-time fingerprint reveal screen with a
 * copy-to-clipboard button.
 *
 * `useActionState` was avoided here for the same reason as the login page:
 * its async/redirect timing in Next 15 + React 19 RC has been unreliable
 * enough in practice to leave the form stuck in the pending state.
 */

const ERROR_COPY: Record<
  Extract<OnboardingResult, { ok: false }>['error'],
  string
> = {
  already_onboarded: 'Onboarding has already been completed for this dashboard.',
  weak_password: 'Password must be at least 12 characters.',
  invalid_fingerprint:
    'Fingerprint must be hex or base64 representing at least 32 bytes.',
  username_required: 'Username is required.',
};

type ErrorCode = Extract<OnboardingResult, { ok: false }>['error'];

export default function OnboardingPage(): ReactElement {
  const [error, setError] = useState<ErrorCode | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [generate, setGenerate] = useState<boolean>(true);
  const [pending, startTransition] = useTransition();

  if (fingerprint !== null) {
    return <FingerprintReveal fingerprint={fingerprint} />;
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (pending) return;

    const formData = new FormData(event.currentTarget);
    const username = String(formData.get('username') ?? '');
    const password = String(formData.get('password') ?? '');
    const fingerprintField = String(formData.get('fingerprint') ?? '');
    const fingerprintInput = generate ? '' : fingerprintField;
    setError(null);

    startTransition(async () => {
      try {
        const result = await createAdmin({
          username,
          password,
          fingerprint: fingerprintInput,
        });
        if (result.ok) {
          setFingerprint(result.fingerprint);
          return;
        }
        setError(result.error);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown error';
        console.error('onboarding failed:', message);
        setError('username_required');
      }
    });
  };

  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-900 p-6 shadow-xl sm:p-8">
        <h1 className="text-2xl font-semibold text-zinc-100 mb-2">
          BMO Dashboard setup
        </h1>
        <p className="text-sm text-zinc-400 mb-6">
          One-time onboarding. Once you finish, this screen is gone forever.
        </p>

        {error !== null ? (
          <div
            role="alert"
            className="mb-4 rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300"
          >
            {ERROR_COPY[error]}
          </div>
        ) : null}

        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="Admin username" htmlFor="username">
            <input
              id="username"
              name="username"
              type="text"
              required
              autoComplete="username"
              disabled={pending}
              className="w-full rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none disabled:opacity-60"
              placeholder="admin"
            />
          </Field>

          <Field
            label="Password"
            htmlFor="password"
            hint="At least 12 characters."
          >
            <input
              id="password"
              name="password"
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
              disabled={pending}
              className="w-full rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none disabled:opacity-60"
              placeholder="••••••••••••"
            />
          </Field>

          <div className="flex items-start gap-2 pt-1">
            <input
              id="generate"
              name="generate"
              type="checkbox"
              checked={generate}
              onChange={(e) => setGenerate(e.target.checked)}
              disabled={pending}
              className="mt-1 h-4 w-4 rounded border-zinc-700 bg-zinc-950 accent-zinc-200"
            />
            <label htmlFor="generate" className="text-sm text-zinc-300">
              Generate a fingerprint for me
              <span className="block text-xs text-zinc-500">
                Recommended. We will show the plaintext value once on the next
                screen for you to flash into the BMO firmware.
              </span>
            </label>
          </div>

          {generate ? null : (
            <Field
              label="ESP32 fingerprint"
              htmlFor="fingerprint"
              hint="Hex or base64. Must decode to at least 32 bytes."
            >
              <input
                id="fingerprint"
                name="fingerprint"
                type="text"
                autoComplete="off"
                disabled={pending}
                className="w-full rounded border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none disabled:opacity-60"
                placeholder="64+ hex chars or base64"
              />
            </Field>
          )}

          <button
            type="submit"
            disabled={pending}
            className="w-full rounded bg-zinc-100 px-4 py-2 font-medium text-zinc-950 transition hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
          >
            {pending ? 'Creating admin…' : 'Complete onboarding'}
          </button>
        </form>
      </div>
    </main>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: ReactElement;
}): ReactElement {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="mb-1 block text-sm font-medium text-zinc-300"
      >
        {label}
      </label>
      {children}
      {hint !== undefined ? (
        <p className="mt-1 text-xs text-zinc-500">{hint}</p>
      ) : null}
    </div>
  );
}

function FingerprintReveal({
  fingerprint,
}: {
  fingerprint: string;
}): ReactElement {
  const [copied, setCopied] = useState<boolean>(false);

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(fingerprint);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-xl rounded-lg border border-zinc-800 bg-zinc-900 p-6 shadow-xl sm:p-8">
        <h1 className="text-2xl font-semibold text-zinc-100 mb-2">
          Save your fingerprint
        </h1>
        <p className="text-sm text-zinc-400 mb-6">
          This is the only time you will see this value. Copy it now and flash
          it into the BMO firmware as <code>BMO_FINGERPRINT</code>. The hashed
          version is stored in the dashboard; we cannot show you the plaintext
          again.
        </p>

        <div className="mb-4 rounded border border-zinc-800 bg-zinc-950 p-3">
          <code className="block break-all font-mono text-sm text-zinc-200">
            {fingerprint}
          </code>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={() => {
              void handleCopy();
            }}
            className="flex-1 rounded bg-zinc-100 px-4 py-2 font-medium text-zinc-950 transition hover:bg-white"
          >
            {copied ? 'Copied' : 'Copy to clipboard'}
          </button>
          <a
            href="/login"
            className="flex-1 rounded border border-zinc-700 px-4 py-2 text-center font-medium text-zinc-100 transition hover:bg-zinc-800"
          >
            Continue to login
          </a>
        </div>
      </div>
    </main>
  );
}
