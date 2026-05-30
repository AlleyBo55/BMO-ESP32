import 'server-only';

import { Buffer } from 'node:buffer';

import { verifyFingerprint } from '@/app/api/_lib/fingerprint-guard';
import { writeActivityLog, type ActivityLogRow } from '@/app/api/_lib/log';
import { getConfig } from '@/lib/config';
import { OpenRouterError, synthesizeSpeech } from '@/lib/openrouter';
import { BMO_SPEECH_INSTRUCTIONS, BMO_SPEECH_MODEL } from '@/lib/voice';
import { applyRadioFx } from '@/lib/voice-fx';
import { buildWavHeader } from '@/lib/wav';

/**
 * POST /api/voice/tts
 *
 * Firmware-facing text-to-speech endpoint. Streams PCM16 mono 24 kHz back
 * to the caller, optionally wrapped in a streaming WAV header.
 *
 * Request body (JSON): `{ text: string; voice?: string; format?: 'pcm16'|'wav' }`.
 *
 * Response:
 *   - `format = 'wav'`  → `audio/wav` with a 44-byte streaming WAV header
 *     (dataSize = 0xFFFFFFFF) prefixed before the first PCM chunk.
 *   - `format = 'pcm16'` (default) → `audio/L16;rate=24000;channels=1`,
 *     raw PCM bytes only.
 *
 * Pre-stream errors (auth, oversize payload, OpenRouter open-fails) return
 * 502 JSON. Mid-stream errors close the connection abruptly via
 * `controller.error`. In every case, exactly one `activity_log` row is
 * written (Property 20) once the stream terminates one way or the other.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Vercel function runtime cap, in seconds.
 *
 * TTS streams for the full duration of the spoken reply. 60s is the Hobby
 * plan max; Pro plans can raise to 300s.
 */
export const maxDuration = 60;

/** Per OpenRouter PCM16 contract. */
const PCM_SAMPLE_RATE_HZ = 24_000;

/** "Streaming WAV" sentinel: tells tolerant decoders the size is unknown. */
const STREAMING_DATA_SIZE = 0xffffffff;

/** Hard cap on synth input. */
const MAX_TEXT_CHARS = 4_000;

interface TtsRequestBody {
  text: string;
  voice?: string;
  format?: 'pcm16' | 'wav';
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseBody(value: unknown): TtsRequestBody | null {
  if (!isRecord(value)) return null;
  if (typeof value.text !== 'string' || value.text.length === 0) return null;
  const out: TtsRequestBody = { text: value.text };
  if (typeof value.voice === 'string' && value.voice.length > 0) {
    out.voice = value.voice;
  }
  if (value.format === 'pcm16' || value.format === 'wav') {
    out.format = value.format;
  }
  return out;
}

export async function POST(req: Request): Promise<Response> {
  const startedAt = Date.now();

  // ------------------- pre-flight auth --------------------------------------
  const guard = await verifyFingerprint(req);
  if (!guard.ok) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  // ------------------- parse + validate body --------------------------------
  let parsedBody: unknown;
  try {
    parsedBody = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }
  const body = parseBody(parsedBody);
  if (body === null) {
    return jsonResponse({ error: 'invalid_body' }, 400);
  }
  if (body.text.length > MAX_TEXT_CHARS) {
    return jsonResponse({ error: 'payload_too_large' }, 413);
  }

  // ------------------- load defaults from config ----------------------------
  const cfg = await getConfig();
  const voice = body.voice ?? cfg.tts_voice;
  const format = body.format ?? 'pcm16';
  // Spoken replies use the dedicated verbatim TTS model, not cfg.tts_model
  // (which is the chat-audio model reserved for singing). Log the real one.
  const ttsModel = BMO_SPEECH_MODEL;
  const inputText = body.text;

  /**
   * Centralised log writer used by every termination path of the stream.
   * The `logged` flag prevents double-writes if `cancel` and the start
   * loop both reach termination.
   */
  let logged = false;
  async function logOutcome(
    status: 'ok' | 'error',
    errorMessage: string | null,
  ): Promise<void> {
    if (logged) return;
    logged = true;
    const totalMs = Date.now() - startedAt;
    const row: ActivityLogRow =
      status === 'ok'
        ? {
            type: 'tts',
            input_text: inputText,
            total_ms: totalMs,
            status: 'ok',
            model_tts: ttsModel,
          }
        : {
            type: 'tts',
            input_text: inputText,
            total_ms: totalMs,
            status: 'error',
            error_stage: 'tts',
            error_message: errorMessage ?? 'unknown',
            model_tts: ttsModel,
          };
    try {
      await writeActivityLog(row);
    } catch {
      /* swallow: log infrastructure failure must not change the response */
    }
  }

  // ------------------- open the upstream stream eagerly ---------------------
  // If the upstream fails before yielding any frames, we still have a chance
  // to send a JSON 502 instead of a half-open audio response.
  let iterator: AsyncIterator<Buffer>;
  try {
    const it = applyRadioFx(
      synthesizeSpeech({
        model: BMO_SPEECH_MODEL,
        voice,
        text: inputText,
        instructions: BMO_SPEECH_INSTRUCTIONS,
        signal: req.signal,
      }),
    );
    iterator = it[Symbol.asyncIterator]();
  } catch (err) {
    const message =
      err instanceof OpenRouterError
        ? err.message
        : err instanceof Error
        ? err.message
        : 'unknown error';
    await logOutcome('error', message);
    return jsonResponse({ stage: 'tts', error: message }, 502);
  }

  // ------------------- streamed response ------------------------------------
  const stream = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      if (format === 'wav') {
        const header = buildWavHeader({
          pcmByteLength: STREAMING_DATA_SIZE,
          sampleRate: PCM_SAMPLE_RATE_HZ,
          channels: 1,
          bitsPerSample: 16,
        });
        controller.enqueue(new Uint8Array(header));
      }

      try {
        while (true) {
          const next = await iterator.next();
          if (next.done === true) break;
          controller.enqueue(new Uint8Array(next.value));
        }
        controller.close();
        await logOutcome('ok', null);
      } catch (err) {
        const message =
          err instanceof OpenRouterError
            ? err.message
            : err instanceof Error
            ? err.message
            : String(err);
        await logOutcome('error', message);
        controller.error(err);
      }
    },
    cancel: async (reason) => {
      // Caller went away (firmware released the touch button). Politely
      // shut down the upstream iterator if it supports `return()`.
      if (typeof iterator.return === 'function') {
        try {
          await iterator.return(reason);
        } catch {
          /* ignore */
        }
      }
      await logOutcome(
        'error',
        reason instanceof Error ? reason.message : 'client_cancelled',
      );
    },
  });

  const headers = new Headers({
    'Content-Type':
      format === 'wav' ? 'audio/wav' : 'audio/L16;rate=24000;channels=1',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
    'Transfer-Encoding': 'chunked',
    'X-BMO-Volume': String(cfg.volume),
  });

  return new Response(stream, { status: 200, headers });
}
