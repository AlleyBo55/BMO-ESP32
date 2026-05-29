/**
 * Tests for `app/api/_lib/log.ts` — the activity-log sanitizer.
 *
 * Property 14 (Log sanitization): rows touching the sanitizer must have any
 * secret-shaped value replaced by `[redacted]` before they reach Supabase.
 * The 8 KiB truncation rule (Requirement 11.4) caps `input_text` and
 * `reply_text` to keep raw audio transcripts and long replies bounded.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  createMockServiceClient,
  getActivityLog,
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
  vi.restoreAllMocks();
});

const REDACTED = '[redacted]';

describe('writeActivityLog sanitization', () => {
  test.each([
    {
      label: 'Anthropic key',
      payload: 'leaked: sk-ant-abc123def456ghi789jkl012mno345pqr678stu901',
    },
    {
      label: 'OpenRouter key',
      payload: 'leaked: sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789',
    },
    {
      label: 'AWS access key',
      payload: 'leaked: AKIAIOSFODNN7EXAMPLE plus padding',
    },
    {
      label: 'Authorization Bearer',
      payload: 'Authorization: Bearer xyz.eyJhbGciOiJIUzI1NiJ9.token',
    },
    {
      label: 'password JSON',
      payload: 'failure body {"password":"hunter2","ok":false}',
    },
    {
      label: 'fingerprint JSON',
      payload: 'header dump {"fingerprint":"deadbeefcafe0123baadf00d4242424242"}',
    },
  ])('redacts $label from input_text and reply_text', async ({ payload }) => {
    const log = await import('@/app/api/_lib/log');
    await log.writeActivityLog({
      type: 'brain',
      input_text: payload,
      reply_text: payload,
      total_ms: 100,
      status: 'ok',
    });

    const rows = getActivityLog(mockClient);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(String(row?.['input_text'] ?? '')).toContain(REDACTED);
    expect(String(row?.['reply_text'] ?? '')).toContain(REDACTED);
    // None of the original secret-shaped fragments survive.
    expect(String(row?.['input_text'] ?? '')).not.toMatch(
      /sk-(ant|or-v1)-|AKIA[0-9A-Z]{12,}|Bearer\s+[A-Za-z0-9._-]+|"password"\s*:\s*"[^"]+"|"fingerprint"\s*:\s*"[^"]+"/i,
    );
    expect(String(row?.['reply_text'] ?? '')).not.toMatch(
      /sk-(ant|or-v1)-|AKIA[0-9A-Z]{12,}|Bearer\s+[A-Za-z0-9._-]+|"password"\s*:\s*"[^"]+"|"fingerprint"\s*:\s*"[^"]+"/i,
    );
  });

  test('truncates input_text to 8 KiB', async () => {
    const log = await import('@/app/api/_lib/log');
    const tenK = 'a'.repeat(10_000);

    await log.writeActivityLog({
      type: 'stt',
      input_text: tenK,
      total_ms: 50,
      status: 'ok',
    });

    const rows = getActivityLog(mockClient);
    const stored = String(rows[0]?.['input_text'] ?? '');
    expect(stored.length).toBe(8192);
  });

  test('truncates reply_text to 8 KiB', async () => {
    const log = await import('@/app/api/_lib/log');
    const tenK = 'b'.repeat(10_000);

    await log.writeActivityLog({
      type: 'brain',
      reply_text: tenK,
      total_ms: 50,
      status: 'ok',
    });

    const rows = getActivityLog(mockClient);
    const stored = String(rows[0]?.['reply_text'] ?? '');
    expect(stored.length).toBe(8192);
  });

  test('writes exactly one row per call', async () => {
    const log = await import('@/app/api/_lib/log');
    await log.writeActivityLog({
      type: 'tts',
      input_text: 'hello',
      total_ms: 10,
      status: 'ok',
    });
    expect(getActivityLog(mockClient)).toHaveLength(1);
  });
});
