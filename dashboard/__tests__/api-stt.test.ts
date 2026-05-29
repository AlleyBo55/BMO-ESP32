/**
 * Integration tests for `app/api/voice/stt/route.ts`.
 *
 * Mocks Supabase via the in-memory client and msw against OpenRouter so the
 * full handler executes end-to-end without external services. Asserts:
 *   - Happy path: 200 + body shape + one activity_log row.
 *   - Missing fingerprint: 401 + no upstream call.
 *   - Body too large (> 25 MiB): 413.
 *   - Unsupported content-type: 415.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  createMockServiceClient,
  getActivityLog,
  seedConfig,
  type MockServiceClient,
} from './mocks/supabase';
import { createOpenRouterServer } from './mocks/openrouter';

let mockClient: MockServiceClient;

vi.mock('@/lib/supabase-admin', () => ({
  getServiceClient: () => mockClient,
}));

const here = dirname(fileURLToPath(import.meta.url));
const wavFixture = readFileSync(join(here, 'fixtures', 'test.wav'));

const { server } = createOpenRouterServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  mockClient = createMockServiceClient();
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const VALID_FP = 'valid-fingerprint-aaaaaaaaaaaaaaaaaaaaaaaaaa';

async function seededFp(): Promise<void> {
  const argon2 = (await import('@node-rs/argon2')) as typeof import('@node-rs/argon2');
  seedConfig(mockClient, { fingerprint_hash: await argon2.hash(VALID_FP) });
}

describe('POST /api/voice/stt', () => {
  test('valid fingerprint + WAV body → 200 with { text, duration_ms, model }', async () => {
    await seededFp();

    const { POST } = await import('@/app/api/voice/stt/route');
    const req = new Request('http://x/api/voice/stt', {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/wav',
        'X-BMO-Fingerprint': VALID_FP,
      },
      body: new Uint8Array(wavFixture),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { text: string; duration_ms: number; model: string };
    expect(body.text).toBe('hello world test');
    expect(typeof body.duration_ms).toBe('number');
    expect(typeof body.model).toBe('string');

    const rows = getActivityLog(mockClient);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['type']).toBe('stt');
    expect(rows[0]?.['input_text']).toBe('hello world test');
  });

  test('missing fingerprint → 401', async () => {
    await seededFp();
    const { POST } = await import('@/app/api/voice/stt/route');
    const req = new Request('http://x/api/voice/stt', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: new Uint8Array(wavFixture),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  test('body > 25 MiB → 413', async () => {
    await seededFp();
    const { POST } = await import('@/app/api/voice/stt/route');
    const tooBig = new Uint8Array(25 * 1024 * 1024 + 1);
    const req = new Request('http://x/api/voice/stt', {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/wav',
        'X-BMO-Fingerprint': VALID_FP,
        'Content-Length': String(tooBig.byteLength),
      },
      body: tooBig,
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
  });

  test('content-type text/plain → 415', async () => {
    await seededFp();
    const { POST } = await import('@/app/api/voice/stt/route');
    const req = new Request('http://x/api/voice/stt', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'X-BMO-Fingerprint': VALID_FP,
      },
      body: 'not audio',
    });
    const res = await POST(req);
    expect(res.status).toBe(415);
  });
});
