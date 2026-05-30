import 'server-only';

import { Buffer } from 'node:buffer';

import { requireAdmin } from '@/lib/api-auth';
import { getConfig } from '@/lib/config';
import { OpenRouterError, synthesizeStream } from '@/lib/openrouter';
import { generateThought } from '@/lib/thoughts';
import { BMO_VOICE_DIRECTION } from '@/lib/voice';
import { applyRadioFx } from '@/lib/voice-fx';
import { wrapPcm16AsWav } from '@/lib/wav';

/**
 * POST /api/sim/thought — simulator for BMO's spontaneous "random thought".
 *
 * Browser-facing. Runs the same idle-thought cognition the firmware path runs
 * in `/api/brain/idle-thought` (recall + child profile → muse via gpt-4.1-mini
 * → capture back as a `'thought'` memory) but returns a COMPLETE, playable WAV
 * plus the thought text + metadata as response headers, so the dashboard's
 * "Random thoughts" tester can show what BMO mused and let you hear it.
 *
 * Unlike the device route, this does NOT gate on the `random_thoughts` skill:
 * the operator is explicitly testing the feature, so we always generate one.
 *
 * Request:  (no body)
 * Response: `audio/wav` bytes, plus
 *   X-BMO-Thought-Text  — URL-encoded musing
 *   X-BMO-Sim-Ms        — wall-clock latency
 *   X-BMO-Sim-Model     — TTS model used
 *   X-BMO-Thought-Seeds — how many memories seeded the thought
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const PCM_SAMPLE_RATE_HZ = 24_000;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export async function POST(req: Request): Promise<Response> {
  const startedAt = Date.now();

  if (!(await requireAdmin(req))) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  const cfg = await getConfig();

  // 1. Generate the thought (recall → muse → capture). Always test-generates,
  //    regardless of the skill toggle, since the operator asked for one.
  const thought = await generateThought(req.signal);
  if (thought === null) {
    return jsonResponse(
      { stage: 'llm', error: 'thought_generation_failed', ms: Date.now() - startedAt },
      502,
    );
  }

  // 2. Synthesize to a finite, playable WAV (buffer all PCM, then wrap).
  const chunks: Buffer[] = [];
  try {
    for await (const frame of applyRadioFx(
      synthesizeStream({
        model: cfg.tts_model,
        voice: cfg.tts_voice,
        text: thought.text,
        systemPrompt: BMO_VOICE_DIRECTION,
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
    // Still hand back the thought text so the UI can show it even if TTS failed.
    return new Response(JSON.stringify({ stage: 'tts', error: message, thought: thought.text }), {
      status: 502,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-BMO-Thought-Text': encodeURIComponent(thought.text),
      },
    });
  }

  const pcm = Buffer.concat(chunks);
  if (pcm.byteLength === 0) {
    return jsonResponse(
      { stage: 'tts', error: 'no_audio_produced', thought: thought.text, ms: Date.now() - startedAt },
      502,
    );
  }

  const wav = wrapPcm16AsWav(pcm, PCM_SAMPLE_RATE_HZ);

  return new Response(new Uint8Array(wav), {
    status: 200,
    headers: {
      'Content-Type': 'audio/wav',
      'Content-Length': String(wav.byteLength),
      'Cache-Control': 'no-store',
      'X-BMO-Thought-Text': encodeURIComponent(thought.text),
      'X-BMO-Thought-Seeds': String(thought.seededFrom),
      'X-BMO-Sim-Ms': String(Date.now() - startedAt),
      'X-BMO-Sim-Model': cfg.tts_model,
    },
  });
}
