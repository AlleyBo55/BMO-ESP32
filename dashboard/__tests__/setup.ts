/**
 * Vitest global setup.
 *
 * - Populates the env vars that `lib/env.ts` validates at module init so that
 *   importing any server module under test does not throw.
 * - Mocks `server-only` so files that begin with `import 'server-only'` work
 *   under Node test runner (the real package errors out in non-server bundles).
 * - Mocks `next/headers` cookies/headers helpers with in-memory shims so that
 *   server actions and middleware-adjacent code is testable.
 */

import { vi } from 'vitest';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY =
  'test-publishable-key-1234567890123456789012';
process.env.SUPABASE_SECRET_KEY =
  'test-secret-key-1234567890123456789012';
process.env.OPENROUTER_API_KEY = 'test-or-key-1234567890123456789012';
process.env.AUTH_SESSION_SECRET = 'test-secret-' + 'a'.repeat(32);

// `server-only` throws at import time in any non-server bundle. Vitest runs
// in Node so the real check would pass, but several CI runners flag it. The
// stub keeps the import side-effect-free.
vi.mock('server-only', () => ({}));

// Minimal in-memory shim for `next/headers`. Only the surface used by the
// dashboard server actions / route handlers is implemented.
type CookieAttributes = {
  name: string;
  value: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'lax' | 'strict' | 'none';
  path?: string;
  maxAge?: number;
};

class CookieJar {
  private readonly store = new Map<string, CookieAttributes>();

  get(name: string): { name: string; value: string } | undefined {
    const entry = this.store.get(name);
    return entry ? { name: entry.name, value: entry.value } : undefined;
  }

  getAll(): Array<{ name: string; value: string }> {
    return Array.from(this.store.values()).map(({ name, value }) => ({
      name,
      value,
    }));
  }

  set(arg: string | CookieAttributes, value?: string, options?: Partial<CookieAttributes>): void {
    if (typeof arg === 'string') {
      this.store.set(arg, { name: arg, value: value ?? '', ...(options ?? {}) });
      return;
    }
    this.store.set(arg.name, arg);
  }

  delete(name: string): void {
    this.store.delete(name);
  }

  has(name: string): boolean {
    return this.store.has(name);
  }
}

class HeaderBag {
  private readonly store = new Map<string, string>();

  get(name: string): string | null {
    return this.store.get(name.toLowerCase()) ?? null;
  }

  set(name: string, value: string): void {
    this.store.set(name.toLowerCase(), value);
  }

  has(name: string): boolean {
    return this.store.has(name.toLowerCase());
  }

  entries(): IterableIterator<[string, string]> {
    return this.store.entries();
  }
}

const cookieJar = new CookieJar();
const headerBag = new HeaderBag();

vi.mock('next/headers', () => ({
  cookies: async () => cookieJar,
  headers: async () => headerBag,
}));

/** Reset between tests to keep behaviour deterministic. */
export function resetTestRequestState(): void {
  for (const { name } of cookieJar.getAll()) {
    cookieJar.delete(name);
  }
  for (const [k] of Array.from(headerBag.entries())) {
    headerBag.set(k, '');
  }
}
