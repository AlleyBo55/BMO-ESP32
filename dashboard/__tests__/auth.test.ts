/**
 * Tests for `lib/auth.ts`.
 *
 * Covers:
 *   - argon2id round-trip and tamper detection
 *   - login lockout window (>=5 fails in last 15 min)
 *   - clearAttempts deletes only the named user's rows
 *
 * Supabase is replaced with the in-memory mock; argon2 is real (deterministic
 * within a test). Test-time clock is frozen via `vi.useFakeTimers` only where
 * the lockout-window logic depends on relative timestamps.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  createMockServiceClient,
  seedAuthAttempt,
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

describe('hashPassword / verifyPassword', () => {
  test('round-trips for several distinct passwords', async () => {
    const auth = await import('@/lib/auth');
    const samples = [
      'correct horse battery staple',
      'p@ssw0rd-with-symbols!#$',
      'short12chars',
      '一二三四五六七八九十十一十二',
      'ABCDEFGHIJ' + '1234567890'.repeat(5),
    ];
    for (const pw of samples) {
      const hash = await auth.hashPassword(pw);
      expect(hash).not.toEqual(pw);
      expect(await auth.verifyPassword(pw, hash)).toBe(true);
      expect(await auth.verifyPassword(pw + 'x', hash)).toBe(false);
    }
  });

  test('verifyPassword returns false on tampered hash', async () => {
    const auth = await import('@/lib/auth');
    const pw = 'correct password 12';
    const hash = await auth.hashPassword(pw);
    // Flip a char in the middle of the hash; argon2 verify must reject.
    const tampered = hash.slice(0, hash.length - 4) + 'AAAA';
    expect(await auth.verifyPassword(pw, tampered)).toBe(false);
  });
});

describe('isLockedOut', () => {
  test('returns true after 5 attempts in the last 15 minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T12:00:00Z'));

    for (let i = 0; i < 5; i += 1) {
      const ts = new Date(Date.now() - i * 60_000).toISOString();
      seedAuthAttempt(mockClient, 'admin', ts);
    }

    const auth = await import('@/lib/auth');
    expect(await auth.isLockedOut('admin')).toBe(true);
  });

  test('returns false with only 4 attempts in the window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T12:00:00Z'));

    for (let i = 0; i < 4; i += 1) {
      const ts = new Date(Date.now() - i * 60_000).toISOString();
      seedAuthAttempt(mockClient, 'admin', ts);
    }

    const auth = await import('@/lib/auth');
    expect(await auth.isLockedOut('admin')).toBe(false);
  });

  test('excludes attempts older than 15 minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T12:00:00Z'));

    // 5 attempts but all 16 minutes ago — outside the rolling window.
    for (let i = 0; i < 5; i += 1) {
      const ts = new Date(Date.now() - (16 + i) * 60_000).toISOString();
      seedAuthAttempt(mockClient, 'admin', ts);
    }

    const auth = await import('@/lib/auth');
    expect(await auth.isLockedOut('admin')).toBe(false);
  });
});

describe('clearAttempts', () => {
  test('removes only the named user rows', async () => {
    seedAuthAttempt(mockClient, 'alice', new Date().toISOString());
    seedAuthAttempt(mockClient, 'alice', new Date().toISOString());
    seedAuthAttempt(mockClient, 'bob', new Date().toISOString());

    const auth = await import('@/lib/auth');
    await auth.clearAttempts('alice');

    const remaining = mockClient.tables.auth_attempts;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.['username']).toBe('bob');
  });
});

describe('recordFailedAttempt', () => {
  test('inserts a single row with the given username', async () => {
    const auth = await import('@/lib/auth');
    await auth.recordFailedAttempt('alice');
    const rows = mockClient.tables.auth_attempts;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['username']).toBe('alice');
  });
});
