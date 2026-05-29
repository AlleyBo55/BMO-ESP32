/**
 * Tests for the `createAdmin` server action.
 *
 * Covers the four documented branches:
 *   - Fresh DB: insert succeeds, returns the plaintext fingerprint.
 *   - Second call: returns `already_onboarded`.
 *   - Password length 11: returns `weak_password`.
 *   - Empty username: returns `username_required`.
 *   - Generated fingerprint: when input fingerprint is empty, action returns
 *     a 64-hex-char value (≥32 bytes of entropy).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createMockServiceClient, type MockServiceClient } from './mocks/supabase';

let mockClient: MockServiceClient;

vi.mock('@/lib/supabase-admin', () => ({
  getServiceClient: () => mockClient,
}));

beforeEach(() => {
  mockClient = createMockServiceClient();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createAdmin', () => {
  test('fresh DB: succeeds and returns plaintext fingerprint', async () => {
    const { createAdmin } = await import('@/app/onboarding/actions');

    const fingerprint = 'a'.repeat(64); // 32 bytes hex
    const res = await createAdmin({
      username: 'admin',
      password: 'password-1234',
      fingerprint,
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.fingerprint).toBe(fingerprint);
    expect(mockClient.tables.admin).toHaveLength(1);
    expect(mockClient.tables.config).toHaveLength(1);
    // The raw fingerprint is never persisted — only the hash.
    const cfg = mockClient.tables.config[0];
    expect(String(cfg?.['fingerprint_hash'] ?? '')).not.toContain(fingerprint);
  });

  test('second call returns { ok: false, error: "already_onboarded" }', async () => {
    const { createAdmin } = await import('@/app/onboarding/actions');

    const fingerprint = 'a'.repeat(64);
    await createAdmin({ username: 'admin', password: 'password-1234', fingerprint });

    const second = await createAdmin({
      username: 'other',
      password: 'password-5678',
      fingerprint: 'b'.repeat(64),
    });
    expect(second).toEqual({ ok: false, error: 'already_onboarded' });
    expect(mockClient.tables.admin).toHaveLength(1);
  });

  test('password length 11 returns weak_password', async () => {
    const { createAdmin } = await import('@/app/onboarding/actions');

    const res = await createAdmin({
      username: 'admin',
      password: '12345678901', // 11 chars
      fingerprint: 'a'.repeat(64),
    });

    expect(res).toEqual({ ok: false, error: 'weak_password' });
    expect(mockClient.tables.admin).toHaveLength(0);
  });

  test('empty username returns username_required', async () => {
    const { createAdmin } = await import('@/app/onboarding/actions');

    const res = await createAdmin({
      username: '',
      password: 'password-1234',
      fingerprint: 'a'.repeat(64),
    });

    expect(res).toEqual({ ok: false, error: 'username_required' });
    expect(mockClient.tables.admin).toHaveLength(0);
  });

  test('empty fingerprint generates a 64-hex-char value', async () => {
    const { createAdmin } = await import('@/app/onboarding/actions');

    const res = await createAdmin({
      username: 'admin',
      password: 'password-1234',
      fingerprint: '',
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
