/**
 * Tests for `lib/openrouter.ts`.
 *
 * Verifies request body shape (model, system message ordering, audio payload
 * encoding), SSE parsing for the streaming TTS path, and AbortController
 * propagation. msw intercepts the OpenRouter HTTP layer.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { http, HttpResponse } from 'msw';

import {
  createOpenRouterServer,
  expectedStreamBytes,
  PCM16_FIXTURE_BYTES,
} from './mocks/openrouter';

const { server, captured } = createOpenRouterServer({ streaming: true, audioFrames: 3 });

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  captured.length = 0;
});
afterAll(() => server.close());

describe('chat()', () => {
  test('sends model + system message first, then user message', async () => {
    const or = await import('@/lib/openrouter');
    const res = await or.chat({
      model: 'openai/gpt-4.1-mini',
      systemPrompt: 'You are BMO.',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(res.text).toBe('reply text');
    expect(captured).toHaveLength(1);

    const body = captured[0]?.body as {
      model?: string;
      messages?: Array<{ role: string; content: string }>;
    } | null;
    expect(body?.model).toBe('openai/gpt-4.1-mini');
    expect(body?.messages?.[0]?.role).toBe('system');
    expect(body?.messages?.[0]?.content).toBe('You are BMO.');
    expect(body?.messages?.[1]?.role).toBe('user');
    expect(body?.messages?.[1]?.content).toBe('hi');
  });

  test('throws OpenRouterError tagged stage=llm on non-2xx', async () => {
    server.use(
      http.post('https://openrouter.ai/api/v1/chat/completions', () =>
        HttpResponse.json({ error: { message: 'overloaded' } }, { status: 503 }),
      ),
    );
    const or = await import('@/lib/openrouter');
    await expect(
      or.chat({
        model: 'openai/gpt-4.1-mini',
        systemPrompt: 's',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ stage: 'llm', status: 503 });
  });

  test('aborts via AbortController', async () => {
    server.use(
      http.post(
        'https://openrouter.ai/api/v1/chat/completions',
        async () => new Promise(() => {}),
      ),
    );
    const or = await import('@/lib/openrouter');
    const ac = new AbortController();
    const p = or.chat({
      model: 'm',
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'hi' }],
      signal: ac.signal,
    });
    ac.abort();
    await expect(p).rejects.toThrow();
  });
});

describe('transcribe()', () => {
  test('builds the {model, input_audio:{data:base64, format:wav}} body shape', async () => {
    const or = await import('@/lib/openrouter');
    const audio = Buffer.from(new Uint8Array([1, 2, 3, 4, 5]));
    const res = await or.transcribe({
      model: 'qwen/qwen3-asr-flash-2026-02-10',
      audio,
      format: 'wav',
    });
    expect(res.text).toBe('hello world test');

    const body = captured[0]?.body as {
      model?: string;
      input_audio?: { data?: string; format?: string };
    } | null;
    expect(body?.model).toBe('qwen/qwen3-asr-flash-2026-02-10');
    expect(body?.input_audio?.format).toBe('wav');
    // Base64 of [1,2,3,4,5]
    expect(Buffer.from(body?.input_audio?.data ?? '', 'base64')).toEqual(audio);
  });

  test('throws OpenRouterError tagged stage=stt on non-2xx', async () => {
    server.use(
      http.post('https://openrouter.ai/api/v1/audio/transcriptions', () =>
        HttpResponse.json({ error: { message: 'bad audio' } }, { status: 400 }),
      ),
    );
    const or = await import('@/lib/openrouter');
    await expect(
      or.transcribe({
        model: 'qwen/qwen3-asr-flash-2026-02-10',
        audio: Buffer.alloc(8),
        format: 'wav',
      }),
    ).rejects.toMatchObject({ stage: 'stt', status: 400 });
  });

  test('AbortController propagates', async () => {
    server.use(
      http.post(
        'https://openrouter.ai/api/v1/audio/transcriptions',
        async () => new Promise(() => {}),
      ),
    );
    const or = await import('@/lib/openrouter');
    const ac = new AbortController();
    const p = or.transcribe({
      model: 'qwen/qwen3-asr-flash-2026-02-10',
      audio: Buffer.alloc(4),
      format: 'wav',
      signal: ac.signal,
    });
    ac.abort();
    await expect(p).rejects.toThrow();
  });
});

describe('synthesizeStream()', () => {
  test('parses SSE frames and yields PCM16 buffers totalling fixture bytes', async () => {
    const or = await import('@/lib/openrouter');
    const stream = or.synthesizeStream({
      model: 'openai/gpt-audio-mini',
      voice: 'nova',
      text: 'hello',
    });
    let total = 0;
    for await (const chunk of stream) {
      total += chunk.byteLength;
    }
    expect(total).toBe(expectedStreamBytes(3));
    expect(total).toBe(PCM16_FIXTURE_BYTES * 3);
  });

  test('AbortController stops the stream', async () => {
    const or = await import('@/lib/openrouter');
    const ac = new AbortController();
    ac.abort();
    const stream = or.synthesizeStream({
      model: 'openai/gpt-audio-mini',
      voice: 'nova',
      text: 'hello',
      signal: ac.signal,
    });
    await expect(async () => {
      for await (const _ of stream) {
        // consume
      }
    }).rejects.toThrow();
  });

  test('throws OpenRouterError tagged stage=tts on upstream non-2xx', async () => {
    server.use(
      http.post('https://openrouter.ai/api/v1/chat/completions', () =>
        HttpResponse.json({ error: 'rate' }, { status: 429 }),
      ),
    );
    const or = await import('@/lib/openrouter');
    await expect(async () => {
      for await (const _ of or.synthesizeStream({
        model: 'openai/gpt-audio-mini',
        voice: 'nova',
        text: 'hello',
      })) {
        // consume
      }
    }).rejects.toMatchObject({ stage: 'tts', status: 429 });
  });
});
