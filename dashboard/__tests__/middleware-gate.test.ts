/**
 * Tests for `app/middleware.ts` — the onboarding/auth gate.
 *
 * Verifies the documented branches:
 *   - Empty admin table + GET /        → 302 /onboarding
 *   - Admin row exists + GET /          → pass-through public landing
 *   - Admin row exists + GET /onboarding → 404
 *   - Empty admin table + GET /onboarding → pass-through (no redirect)
 *   - Admin row + invalid session + GET /soul → 302 /login
 *   - Admin row + valid session + GET /soul → pass-through
 *
 * The middleware runs server-side in a Next.js Edge runtime; for tests we
 * import the handler directly and feed it `NextRequest` instances with the
 * relevant URL/cookies populated.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

import {
  createMockServiceClient,
  seedAdmin,
  type MockServiceClient,
} from './mocks/supabase';

let mockClient: MockServiceClient;

vi.mock('@/lib/supabase-admin', () => ({
  getServiceClient: () => mockClient,
}));

beforeEach(() => {
  mockClient = createMockServiceClient();
  // The middleware caches the admin row count for 30 s at module scope.
  // Reset modules between tests so each one gets a fresh cache.
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeRequest(path: string, cookies: Record<string, string> = {}): NextRequest {
  const url = `http://localhost:3000${path}`;
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  return new NextRequest(url, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  });
}

async function buildSessionCookie(username: string): Promise<string> {
  const auth = await import('@/lib/auth');
  // `issueSessionCookie` may return a Set-Cookie string or a bare JWT depending
  // on the implementation choice; normalize both shapes here.
  const raw: string = await Promise.resolve(auth.issueSessionCookie(username));
  const match = /^[^=]+=([^;]+)/.exec(raw);
  return match?.[1] ?? raw;
}

describe('middleware', () => {
  test('empty admin table + GET / redirects to /onboarding', async () => {
    const { middleware } = await import('@/middleware');
    const res = await middleware(makeRequest('/'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toMatch(/\/onboarding$/);
  });

  test('admin row exists + GET / passes through to public landing', async () => {
    seedAdmin(mockClient, { username: 'admin', password_hash: 'unused' });
    const { middleware } = await import('@/middleware');
    const res = await middleware(makeRequest('/'));
    expect(res.status).not.toBe(307);
    expect(res.status).not.toBe(308);
    expect(res.status).not.toBe(404);
    expect(res.headers.get('location')).toBeNull();
  });

  test('admin row exists + GET /onboarding returns 404', async () => {
    seedAdmin(mockClient, { username: 'admin', password_hash: 'unused' });
    const { middleware } = await import('@/middleware');
    const res = await middleware(makeRequest('/onboarding'));
    expect(res.status).toBe(404);
  });

  test('empty admin table + GET /onboarding passes through', async () => {
    const { middleware } = await import('@/middleware');
    const res = await middleware(makeRequest('/onboarding'));
    // NextResponse.next() carries either status 200 or no redirect/4xx.
    expect(res.status).not.toBe(307);
    expect(res.status).not.toBe(308);
    expect(res.status).not.toBe(404);
    expect(res.headers.get('location')).toBeNull();
  });

  test('admin row + invalid session + GET /soul redirects to /login', async () => {
    seedAdmin(mockClient, { username: 'admin', password_hash: 'unused' });
    const { middleware } = await import('@/middleware');
    const res = await middleware(
      makeRequest('/soul', { bmo_session: 'not-a-valid-jwt' }),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toMatch(/\/login$/);
  });

  test('admin row + valid session + GET /soul passes through', async () => {
    seedAdmin(mockClient, { username: 'admin', password_hash: 'unused' });
    const cookieVal = await buildSessionCookie('admin');
    const { middleware } = await import('@/middleware');
    const res = await middleware(
      makeRequest('/soul', { bmo_session: cookieVal }),
    );
    expect(res.status).not.toBe(307);
    expect(res.status).not.toBe(308);
    expect(res.headers.get('location')).toBeNull();
  });
});
