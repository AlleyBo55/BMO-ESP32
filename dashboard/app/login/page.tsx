'use client';

import { useState, useTransition } from 'react';
import type { FormEvent, ReactElement } from 'react';

import { login, type LoginResult } from './actions';

/**
 * Admin login form.
 *
 * Calls the `login` server action through a plain client fetch (via the
 * direct function reference, which Next.js compiles to an RSC action POST).
 * On success we navigate client-side. We avoid `useActionState` here because
 * its behaviour around redirects and async resolution in Next 15 + React 19
 * RC has been flaky enough in practice to leave the button stuck in the
 * pending state, even when the action has already returned.
 *
 * Rate-limit lockouts get a dedicated message; every other auth failure
 * collapses to one generic line so the response cannot be used to enumerate
 * which usernames exist.
 */

const ERROR_COPY: Record<
  Extract<LoginResult, { ok: false }>['error'],
  string
> = {
  invalid_credentials: 'Invalid username or password.',
  rate_limited: 'Too many attempts, try again in 15 minutes.',
};

export default function LoginPage(): ReactElement {
  const [error, setError] = useState<
    Extract<LoginResult, { ok: false }>['error'] | null
  >(null);
  const [pending, startTransition] = useTransition();

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (pending) return;

    const formData = new FormData(event.currentTarget);
    const username = String(formData.get('username') ?? '');
    const password = String(formData.get('password') ?? '');
    setError(null);

    startTransition(async () => {
      try {
        const result = await login({ username, password });
        if (result.ok) {
          // Hard navigation so the new session cookie is unambiguously
          // attached to the request that hits middleware. `router.replace`
          // + `router.refresh` race the RSC stream against the cookie set
          // and have hung in practice; a full document reload sidesteps it.
          window.location.assign('/');
          return;
        }
        setError(result.error);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown error';
        console.error('login failed:', message);
        setError('invalid_credentials');
      }
    });
  };

  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm rounded-lg border border-zinc-800 bg-zinc-900 p-6 shadow-xl sm:p-8">
        <h1 className="text-2xl font-semibold text-zinc-100 mb-2">Sign in</h1>
        <p className="text-sm text-zinc-400 mb-6">BMO Dashboard admin.</p>

        {error !== null ? (
          <div
            role="alert"
            className="mb-4 rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300"
          >
            {ERROR_COPY[error]}
          </div>
        ) : null}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="username"
              className="mb-1 block text-sm font-medium text-zinc-300"
            >
              Username
            </label>
            <input
              id="username"
              name="username"
              type="text"
              required
              autoComplete="username"
              disabled={pending}
              className="w-full rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none disabled:opacity-60"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="mb-1 block text-sm font-medium text-zinc-300"
            >
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              disabled={pending}
              className="w-full rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none disabled:opacity-60"
            />
          </div>

          <button
            type="submit"
            disabled={pending}
            className="w-full rounded bg-zinc-100 px-4 py-2 font-medium text-zinc-950 transition hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
          >
            {pending ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </main>
  );
}
