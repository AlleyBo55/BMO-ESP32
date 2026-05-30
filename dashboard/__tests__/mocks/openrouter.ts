/**
 * msw handlers and a small SSE fixture for OpenRouter.
 *
 * The dashboard's `lib/openrouter.ts` issues plain `fetch()` requests against
 * `https://openrouter.ai/api/v1/...`. msw intercepts those at the network
 * layer so tests can assert request shape and inject deterministic responses
 * without touching the real OpenRouter API.
 *
 * The streaming chat-completions handler returns three SSE frames carrying
 * base64-encoded PCM16 chunks plus a terminating `[DONE]` frame. The fixture
 * length (200 PCM16 samples = 400 bytes total) is the canonical "first byte"
 * payload for streaming-pipeline tests.
 */

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

/**
 * 100 PCM16 samples of silence (200 bytes) — used by the streaming TTS
 * handler. Two frames of this give 400 audio bytes per response.
 */
export const PCM16_FIXTURE_SAMPLES = 100;
export const PCM16_FIXTURE_BYTES = PCM16_FIXTURE_SAMPLES * 2;

function makePcm16Fixture(): Uint8Array {
  return new Uint8Array(PCM16_FIXTURE_BYTES);
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/**
 * Total bytes a streaming TTS handler emits when given `frameCount` audio
 * frames each carrying `PCM16_FIXTURE_BYTES`.
 */
export function expectedStreamBytes(frameCount: number): number {
  return PCM16_FIXTURE_BYTES * frameCount;
}

export interface CapturedRequest {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

export interface OpenRouterMockOptions {
  /**
   * If true, `/chat/completions` returns a streaming SSE response with audio
   * chunks. Otherwise it returns a plain JSON `text` response.
   */
  streaming?: boolean;
  /** Frame count emitted by the streaming chat-completions handler. */
  audioFrames?: number;
  /** Override the deterministic transcript text. */
  transcript?: string;
  /** Override the deterministic chat reply text. */
  reply?: string;
  /** Force `/credits` to fail with a 502 — used to test stale-cache fallback. */
  creditsFailure?: boolean;
}

/**
 * Builds a fresh msw server with the default OpenRouter handlers. Tests can
 * call `.use(...)` on the returned server to override per-test behaviour.
 */
export function createOpenRouterServer(options: OpenRouterMockOptions = {}): {
  server: ReturnType<typeof setupServer>;
  captured: CapturedRequest[];
} {
  const captured: CapturedRequest[] = [];
  const audioFrames = options.audioFrames ?? 2;
  const transcript = options.transcript ?? 'hello world test';
  const reply = options.reply ?? 'reply text';

  async function captureJson(request: Request): Promise<unknown> {
    try {
      const cloned = request.clone();
      return await cloned.json();
    } catch {
      return null;
    }
  }

  function recordHeaders(request: Request): Record<string, string> {
    const out: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }

  const handlers = [
    http.post('https://openrouter.ai/api/v1/audio/transcriptions', async ({ request }) => {
      const body = await captureJson(request);
      captured.push({
        url: request.url,
        method: request.method,
        body,
        headers: recordHeaders(request),
      });
      return HttpResponse.json({
        text: transcript,
        usage: { seconds: 2, cost: 0.0001 },
      });
    }),

    http.post('https://openrouter.ai/api/v1/chat/completions', async ({ request }) => {
      const body = await captureJson(request);
      captured.push({
        url: request.url,
        method: request.method,
        body,
        headers: recordHeaders(request),
      });

      const wantsStream =
        options.streaming === true ||
        (typeof body === 'object' &&
          body !== null &&
          'stream' in body &&
          (body as { stream?: unknown }).stream === true);

      if (!wantsStream) {
        return HttpResponse.json({
          choices: [{ message: { content: reply } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        });
      }

      const audioBase64 = toBase64(makePcm16Fixture());
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          for (let i = 0; i < audioFrames; i += 1) {
            const frame =
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      audio: { data: audioBase64, format: 'pcm16' },
                    },
                  },
                ],
              })}\n\n`;
            controller.enqueue(encoder.encode(frame));
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });

      return new HttpResponse(stream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    }),

    http.get('https://openrouter.ai/api/v1/credits', ({ request }) => {
      captured.push({
        url: request.url,
        method: request.method,
        body: null,
        headers: recordHeaders(request),
      });
      if (options.creditsFailure) {
        return HttpResponse.json({ error: 'upstream' }, { status: 502 });
      }
      return HttpResponse.json({
        data: { total_credits: 10, total_usage: 2.5 },
      });
    }),

    http.post('https://openrouter.ai/api/v1/embeddings', async ({ request }) => {
      const body = await captureJson(request);
      captured.push({
        url: request.url,
        method: request.method,
        body,
        headers: recordHeaders(request),
      });
      // Deterministic 1536-dim unit-ish vector. Content doesn't matter for
      // tests; the brain layer only needs a well-shaped response so recall /
      // capture / doctor exercise their happy paths.
      const dims =
        typeof body === 'object' &&
        body !== null &&
        'dimensions' in body &&
        typeof (body as { dimensions?: unknown }).dimensions === 'number'
          ? (body as { dimensions: number }).dimensions
          : 1536;
      const embedding = new Array<number>(dims).fill(0.001);
      return HttpResponse.json({
        data: [{ embedding, index: 0 }],
        usage: { prompt_tokens: 4, total_cost: 0.00001 },
      });
    }),
  ];

  return { server: setupServer(...handlers), captured };
}
