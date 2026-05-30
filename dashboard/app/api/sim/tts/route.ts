import 'server-only';

import { Buffer } from 'node:buffer';

import { requireAdmin } from '@/lib/api-auth';
import { getConfig } from '@/lib/config';
import { OpenRouterError, synthesizeStream } from '@/lib/openrouter';
import { BMO_SINGING_DIRECTION, BMO_VOICE_DIRECTION } from '@/lib/voice';
import { applyRadioFx } from '@/lib/voice-fx';
import { wrapPcm16AsWav } from '@/lib/wav';

/**
 * POST /api/sim/tts — simulator text-to-speech stage.
 *
 * Browser-facing. Synthesizes the reply text to a COMPLETE WAV buffer (not a
 * streaming/unknown-size WAV) so the simulator can drop the bytes straight
 * into an <audio> element and play them. The firmware route streams with a
 * 0xFFFFFFFF sentinel size because the device plays as it receives; a browser
 * <audio> element wants a well-formed file, so here we buffer all PCM frames
 * and write an accurate RIFF/data size into the 44-byte header.
 *
 * Request:  `{ text: string, voice?: string }`
 * Response: `audio/wav` bytes, plus `X-BMO-Sim-Ms` / `X-BMO-Sim-Model`
 *           headers so the UI can show latency and the model used.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const PCM_SAMPLE_RATE_HZ = 24_000;
const MAX_TEXT_CHARS = 4_000;

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

export async function POST(req: Request): Promise<Response> {
  const startedAt = Date.now();

  if (!(await requireAdmin(req))) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return jsonResponse({ stage: 'tts', error: 'invalid_json' }, 400);
  }
  if (!isRecord(parsed) || typeof parsed.text !== 'string' || parsed.text.length === 0) {
    return jsonResponse({ stage: 'tts', error: 'invalid_body' }, 400);
  }
  if (parsed.text.length > MAX_TEXT_CHARS) {
    return jsonResponse({ stage: 'tts', error: 'payload_too_large' }, 413);
  }
  const text = parsed.text;

  const cfg = await getConfig();
  const voice = typeof parsed.voice === 'string' && parsed.voice.length > 0 ? parsed.voice : cfg.tts_voice;
  // When `sing` is true the simulator wants BMO to actually sing the text, so
  // we steer synthesis with the singing direction instead of the speaking one.
  const sing = parsed.sing === true;
  const direction = sing ? BMO_SINGING_DIRECTION : BMO_VOICE_DIRECTION;

  // Buffer the whole synthesis so we can emit a finite, playable WAV. The
  // robotic-radio effect is applied as the PCM streams in.
  const chunks: Buffer[] = [];
  try {
    for await (const frame of applyRadioFx(
      synthesizeStream({
        model: cfg.tts_model,
        voice,
        text,
        systemPrompt: direction,
        signal: req.signal,
      }),
    )) {
      chunks.push(frame);
    }
  } catch (err) {
    const message =
      err instanceof OpenRouterError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'unknown error';
    return jsonResponse({ stage: 'tts', error: message, ms: Date.now() - startedAt }, 502);
  }

  const pcm = Buffer.concat(chunks);
  if (pcm.byteLength === 0) {
    return jsonResponse({ stage: 'tts', error: 'no_audio_produced', ms: Date.now() - startedAt }, 502);
  }

  const wav = wrapPcm16AsWav(pcm, PCM_SAMPLE_RATE_HZ);

  return new Response(new Uint8Array(wav), {
    status: 200,
    headers: {
      'Content-Type': 'audio/wav',
      'Content-Length': String(wav.byteLength),
      'Cache-Control': 'no-store',
      'X-BMO-Sim-Ms': String(Date.now() - startedAt),
      'X-BMO-Sim-Model': cfg.tts_model,
      'X-BMO-Sim-Voice': voice,
      'X-BMO-Sim-Sing': sing ? '1' : '0',
    },
  });
}
