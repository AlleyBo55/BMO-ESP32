/**
 * Tests for `app/api/_lib/fingerprint-guard.ts`.
 *
 * Verifies the three rejection paths and the cache-invalidation contract: a
 * fingerprint rotation must propagate to subsequent guard checks within the
 * 5-second config cache window.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  createMockServiceClient,
  seedConfig,
  type MockServiceClient,
} from './mocks/supabase';

let mockClient: MockServiceClient;

vi.mock('@/lib/supabase-admin', () => ({
  getServiceClient: () => mockClient,
}));

beforeEach(() => {
  mockClient = createMockServiceClient();
});

afterEach(() => {
  vi.useRealTimers();
});

async function hashFp(value: string): Promise<string> {
  const argon2 = (await import('@node-rs/argon2')) as typeof import('@node-rs/argon2');
  return argon2.hash(value);
}

describe('verifyFingerprint', () => {
  test('returns reason=missing when header absent', async () => {
    seedConfig(mockClient, { fingerprint_hash: await hashFp('correct-fingerprint-aaaaaaaaaaaaaaaaaaaaa') });

    const guard = await import('@/app/api/_lib/fingerprint-guard');
    const req = new Request('http://x/api/brain', { method: 'POST' });
    const res = await guard.verifyFingerprint(req);
    expect(res).toEqual({ ok: false, reason: 'missing' });
  });

  test('returns reason=mismatch when header value does not verify', async () => {
    seedConfig(mockClient, {
      fingerprint_hash: await hashFp('correct-fingerprint-aaaaaaaaaaaaaaaaaaaaa'),
    });

    const guard = await import('@/app/api/_lib/fingerprint-guard');
    const req = new Request('http://x/api/brain', {
      method: 'POST',
      headers: { 'X-BMO-Fingerprint': 'wrong-fingerprint-zzzzzzzzzzzzzzzzzzzzzz' },
    });
    const res = await guard.verifyFingerprint(req);
    expect(res).toEqual({ ok: false, reason: 'mismatch' });
  });

  test('returns ok on matching fingerprint', async () => {
    const plain = 'correct-fingerprint-aaaaaaaaaaaaaaaaaaaaa';
    seedConfig(mockClient, { fingerprint_hash: await hashFp(plain) });

    const guard = await import('@/app/api/_lib/fingerprint-guard');
    const req = new Request('http://x/api/brain', {
      method: 'POST',
      headers: { 'X-BMO-Fingerprint': plain },
    });
    const res = await guard.verifyFingerprint(req);
    expect(res.ok).toBe(true);
  });

  test('rejects old fingerprint within 5 s after rotation (cache invalidation)', async () => {
    const oldFp = 'old-fingerprint-aaaaaaaaaaaaaaaaaaaaaaaaaa';
    const newFp = 'new-fingerprint-bbbbbbbbbbbbbbbbbbbbbbbbbb';

    seedConfig(mockClient, { fingerprint_hash: await hashFp(oldFp) });

    const guard = await import('@/app/api/_lib/fingerprint-guard');
    const config = await import('@/lib/config');

    // First check: old value passes.
    const ok = await guard.verifyFingerprint(
      new Request('http://x/api/brain', {
        method: 'POST',
        headers: { 'X-BMO-Fingerprint': oldFp },
      }),
    );
    expect(ok.ok).toBe(true);

    // Rotation: write the new hash and ensure the cache is dropped so the
    // next call observes it. `updateConfig` is documented to clear the cache.
    await config.updateConfig({ fingerprint_hash: await hashFp(newFp) });

    const stillOld = await guard.verifyFingerprint(
      new Request('http://x/api/brain', {
        method: 'POST',
        headers: { 'X-BMO-Fingerprint': oldFp },
      }),
    );
    expect(stillOld.ok).toBe(false);
    if (!stillOld.ok) expect(stillOld.reason).toBe('mismatch');

    const newWorks = await guard.verifyFingerprint(
      new Request('http://x/api/brain', {
        method: 'POST',
        headers: { 'X-BMO-Fingerprint': newFp },
      }),
    );
    expect(newWorks.ok).toBe(true);
  });
});
