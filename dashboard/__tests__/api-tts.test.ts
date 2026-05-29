/**
 * Integration tests for `app/api/voice/tts/route.ts`.
 *
 * Verifies:
 *   - Streaming response with the expected Content-Type header.
 *   - Activity log row written with status='ok'.
 *   - Text > 4000 chars → 413.
 */

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

const { server } = createOpenRouterServer({ streaming: true, audioFrames: 2 });

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

async function readAll(res: Response): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

describe('POST /api/voice/tts', () => {
  test('valid fingerprint + { text: "hi" } returns streamed audio', async () => {
    await seededFp();
    const { POST } = await import('@/app/api/voice/tts/route');
    const req = new Request('http://x/api/voice/tts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BMO-Fingerprint': VALID_FP,
      },
      body: JSON.stringify({ text: 'hi' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const ct = res.headers.get('Content-Type') ?? '';
    expect(ct).toMatch(/^audio\/(L16|wav|mpeg)/);

    const body = await readAll(res);
    expect(body.byteLength).toBeGreaterThan(0);
  });

  test('text > 4000 chars → 413', async () => {
    await seededFp();
    const { POST } = await import('@/app/api/voice/tts/route');
    const long = 'a'.repeat(4001);
    const req = new Request('http://x/api/voice/tts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BMO-Fingerprint': VALID_FP,
      },
      body: JSON.stringify({ text: long }),
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
  });

  test('writes one activity_log row with status="ok"', async () => {
    await seededFp();
    const { POST } = await import('@/app/api/voice/tts/route');
    const req = new Request('http://x/api/voice/tts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BMO-Fingerprint': VALID_FP,
      },
      body: JSON.stringify({ text: 'hi' }),
    });
    const res = await POST(req);
    // Drain the body so the `finally` block writes the log row.
    await readAll(res);

    const rows = getActivityLog(mockClient);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['type']).toBe('tts');
    expect(rows[0]?.['status']).toBe('ok');
  });
});
