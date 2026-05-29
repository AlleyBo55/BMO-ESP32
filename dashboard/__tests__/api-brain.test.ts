/**
 * Integration tests for `app/api/brain/route.ts`.
 *
 * Verifies:
 *   - Text input path streams audio back.
 *   - `X-BMO-Reply-Text` header is set and URL-encoded.
 *   - One activity_log row is written with both input_text and reply_text.
 *   - LLM stage failure → 502 { stage: 'llm' } and a log row with
 *     `error_stage='llm'`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { http, HttpResponse } from 'msw';

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

const { server } = createOpenRouterServer({ streaming: true, audioFrames: 2, reply: 'reply text' });

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  mockClient = createMockServiceClient();
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const VALID_FP = 'valid-fingerprint-aaaaaaaaaaaaaaaaaaaaaaaaaa';

async function seededFp(): Promise<void> {
  const argon2 = (await import('@node-rs/argon2')) as typeof import('@node-rs/argon2');
  seedConfig(mockClient, {
    fingerprint_hash: await argon2.hash(VALID_FP),
    soul_md: 'You are BMO.',
  });
}

async function drain(res: Response): Promise<number> {
  const reader = res.body?.getReader();
  if (!reader) return 0;
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) total += value.byteLength;
  }
  return total;
}

describe('POST /api/brain', () => {
  test('text input streams audio back and sets X-BMO-Reply-Text header', async () => {
    await seededFp();
    const { POST } = await import('@/app/api/brain/route');
    const req = new Request('http://x/api/brain', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BMO-Fingerprint': VALID_FP,
      },
      body: JSON.stringify({ text: 'ping' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    const replyHeader = res.headers.get('X-BMO-Reply-Text');
    expect(replyHeader).not.toBeNull();
    if (replyHeader !== null) {
      expect(decodeURIComponent(replyHeader)).toContain('reply text');
    }

    const bytes = await drain(res);
    expect(bytes).toBeGreaterThan(0);
  });

  test('writes one activity_log row carrying input_text and reply_text', async () => {
    await seededFp();
    const { POST } = await import('@/app/api/brain/route');
    const req = new Request('http://x/api/brain', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BMO-Fingerprint': VALID_FP,
      },
      body: JSON.stringify({ text: 'ping' }),
    });
    const res = await POST(req);
    await drain(res);

    const rows = getActivityLog(mockClient);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.['type']).toBe('brain');
    expect(row?.['input_text']).toBe('ping');
    expect(String(row?.['reply_text'] ?? '')).toContain('reply text');
  });

  test('LLM stage failure → 502 { stage: "llm" } + log row with error_stage="llm"', async () => {
    await seededFp();
    server.use(
      http.post('https://openrouter.ai/api/v1/chat/completions', () =>
        HttpResponse.json({ error: { message: 'overloaded' } }, { status: 503 }),
      ),
    );
    const { POST } = await import('@/app/api/brain/route');
    const req = new Request('http://x/api/brain', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BMO-Fingerprint': VALID_FP,
      },
      body: JSON.stringify({ text: 'ping' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { stage?: string };
    expect(body.stage).toBe('llm');

    const rows = getActivityLog(mockClient);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['error_stage']).toBe('llm');
    expect(rows[0]?.['status']).toBe('error');
  });
});
