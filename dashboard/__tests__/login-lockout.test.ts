/**
 * Tests for the login lockout window in the `login` server action.
 *
 * Requirement 2.7: 5+ failed attempts within 15 minutes locks the user out
 * for the remainder of that 15-minute window. After 16 minutes (mocked time)
 * the next attempt is allowed again. A successful login clears the
 * `auth_attempts` rows for that user.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  createMockServiceClient,
  seedAdmin,
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

async function hash(plain: string): Promise<string> {
  const argon2 = (await import('@node-rs/argon2')) as typeof import('@node-rs/argon2');
  return argon2.hash(plain);
}

describe('login lockout', () => {
  test('6th attempt after 5 fails in 14 minutes returns rate_limited', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T12:00:00Z'));

    seedAdmin(mockClient, { username: 'admin', password_hash: await hash('correct-password-12') });
    for (let i = 0; i < 5; i += 1) {
      const ts = new Date(Date.now() - i * 60_000).toISOString();
      seedAuthAttempt(mockClient, 'admin', ts);
    }

    const { login } = await import('@/app/login/actions');
    const res = await login({ username: 'admin', password: 'correct-password-12' });
    expect(res).toEqual({ ok: false, error: 'rate_limited' });
  });

  test('after 16 minutes pass, the next attempt is allowed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T12:00:00Z'));

    seedAdmin(mockClient, { username: 'admin', password_hash: await hash('correct-password-12') });
    for (let i = 0; i < 5; i += 1) {
      const ts = new Date(Date.now() - i * 60_000).toISOString();
      seedAuthAttempt(mockClient, 'admin', ts);
    }

    // Advance 16 minutes — all attempts are now outside the rolling window.
    vi.setSystemTime(new Date('2025-01-01T12:16:01Z'));

    const { login } = await import('@/app/login/actions');
    const res = await login({ username: 'admin', password: 'correct-password-12' });
    expect(res.ok).toBe(true);
  });

  test('successful login clears auth_attempts rows for the user', async () => {
    seedAdmin(mockClient, { username: 'admin', password_hash: await hash('correct-password-12') });
    for (let i = 0; i < 3; i += 1) {
      seedAuthAttempt(mockClient, 'admin', new Date().toISOString());
    }
    seedAuthAttempt(mockClient, 'someone-else', new Date().toISOString());

    const { login } = await import('@/app/login/actions');
    const res = await login({ username: 'admin', password: 'correct-password-12' });
    expect(res.ok).toBe(true);

    const remaining = mockClient.tables.auth_attempts;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.['username']).toBe('someone-else');
  });
});
