import 'server-only';

import { Buffer } from 'node:buffer';

import { verifyFingerprint } from '@/app/api/_lib/fingerprint-guard';
import { writeActivityLog, type ActivityLogRow } from '@/app/api/_lib/log';
import { getConfig } from '@/lib/config';
import { OpenRouterError, synthesizeSpeech } from '@/lib/openrouter';
import { generateThought } from '@/lib/thoughts';
import { BMO_SPEECH_INSTRUCTIONS, BMO_SPEECH_MODEL, toSpeakableText } from '@/lib/voice';
import { applyRadioFx } from '@/lib/voice-fx';
import { buildWavHeader } from '@/lib/wav';

/**
 * GET/POST /api/brain/idle-thought — BMO's spontaneous "random thought".
 *
 * The firmware hits this on an idle timer (every ~3 minutes when BMO isn't
 * talking or being touched). It is the device-facing half of the gbrain /
 * OpenClaw "keep thinking on your own" loop:
 *
 *   1. Verify `X-BMO-Fingerprint` (401 on miss).
 *   2. Gate on the `random_thoughts` skill. If it's off, return 204 No Content
 *      so the device knows to stay quiet without treating it as an error.
 *   3. generateThought(): recall memory + child profile → muse one short
 *      in-character line via gpt-4.1-mini → capture it back as a `'thought'`
 *      memory (so BMO's musings compound over time).
 *   4. Stream the musing as PCM16 TTS in a streaming-WAV wrapper — identical
 *      wire format to `/api/brain`, so the firmware plays it the same way.
 *
 * If thought generation fails (LLM/network), we return 204 rather than 502:
 * a missed idle thought is a non-event, never an error the child should see.
 *
 * Response headers mirror `/api/brain`:
 *   Content-Type:        audio/wav   (streaming WAV header included)
 *   X-BMO-Reply-Text:    the thought text, URL-encoded
 *   X-BMO-Thought:       "1" marker so the firmware can pick an idle face
 *   X-BMO-Volume / X-Accel-Buffering / Cache-Control
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Same Vercel runtime cap as the main brain route (streams for the reply). */
export const maxDuration = 60;

/** PCM16 sample rate produced by OpenRouter audio output. */
const PCM_SAMPLE_RATE_HZ = 24_000;

/** "Streaming WAV" sentinel for tolerant decoders. */
const STREAMING_DATA_SIZE = 0xffffffff;

/** Total budget across recall + LLM + TTS open. Matches the brain route. */
const TOTAL_BUDGET_MS = 60_000;

/** Cap on the X-BMO-Reply-Text header value (pre-URL-encoding). */
const REPLY_HEADER_CHAR_CAP = 1024;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/** 204: BMO chose to stay quiet this cycle (skill off, or generation failed). */
function noContent(): Response {
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

/** ASCII-safe header value of at most `cap` source chars, URL-encoded. */
function encodeReplyHeader(text: string, cap: number): string {
  return encodeURIComponent(text.slice(0, cap));
}

async function handle(req: Request): Promise<Response> {
  const startedAt = Date.now();

  // ------------------- pre-flight auth --------------------------------------
  const guard = await verifyFingerprint(req);
  if (!guard.ok) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  // Total-budget abort wired to req.signal.
  const ac = new AbortController();
  const onAbort = (): void => {
    ac.abort(req.signal.reason);
  };
  if (req.signal.aborted) {
    ac.abort(req.signal.reason);
  } else {
    req.signal.addEventListener('abort', onAbort, { once: true });
  }
  const budgetTimer = setTimeout(() => {
    ac.abort(new Error('budget_exceeded'));
  }, TOTAL_BUDGET_MS);

  const cleanup = (): void => {
    clearTimeout(budgetTimer);
    req.signal.removeEventListener('abort', onAbort);
  };

  let cfg;
  try {
    cfg = await getConfig();
  } catch (err) {
    cleanup();
    const message = err instanceof Error ? err.message : 'config_unavailable';
    return jsonResponse({ error: message }, 500);
  }

  // ------------------- gate on the random_thoughts skill --------------------
  const skill = cfg.skills.random_thoughts;
  if (skill === undefined || !skill.enabled) {
    cleanup();
    return noContent();
  }

  // ------------------- generate the thought (recall → muse → capture) -------
  let thoughtText: string;
  try {
    const thought = await generateThought(ac.signal);
    if (thought === null) {
      cleanup();
      return noContent(); // a missed idle thought is a non-event, not an error
    }
    thoughtText = thought.text;
  } catch {
    cleanup();
    return noContent();
  }

  // ------------------- open TTS stream eagerly ------------------------------
  let iterator: AsyncIterator<Buffer>;
  try {
    const it = applyRadioFx(
      synthesizeSpeech({
        model: BMO_SPEECH_MODEL,
        voice: cfg.tts_voice,
        text: toSpeakableText(thoughtText),
        instructions: BMO_SPEECH_INSTRUCTIONS,
        signal: ac.signal,
      }),
    );
    iterator = it[Symbol.asyncIterator]();
  } catch (err) {
    cleanup();
    const message =
      err instanceof OpenRouterError
        ? err.message
        : err instanceof Error
        ? err.message
        : 'unknown error';
    const failureRow: ActivityLogRow = {
      type: 'brain',
      input_text: '(idle-thought)',
      reply_text: thoughtText,
      total_ms: Date.now() - startedAt,
      status: 'error',
      error_stage: 'tts',
      error_message: message,
      model_llm: cfg.llm_model,
      model_tts: cfg.tts_model,
    };
    try {
      await writeActivityLog(failureRow);
    } catch {
      /* swallow */
    }
    // TTS failed before any audio — stay quiet rather than error the device.
    return noContent();
  }

  // ------------------- streaming response -----------------------------------
  let logged = false;
  const finishLog = async (status: 'ok' | 'error', errorMessage: string | null): Promise<void> => {
    if (logged) return;
    logged = true;
    cleanup();
    const row: ActivityLogRow =
      status === 'ok'
        ? {
            type: 'brain',
            input_text: '(idle-thought)',
            reply_text: thoughtText,
            total_ms: Date.now() - startedAt,
            status: 'ok',
            model_llm: cfg.llm_model,
            model_tts: cfg.tts_model,
          }
        : {
            type: 'brain',
            input_text: '(idle-thought)',
            reply_text: thoughtText,
            total_ms: Date.now() - startedAt,
            status: 'error',
            error_stage: 'tts',
            error_message: errorMessage ?? 'unknown',
            model_llm: cfg.llm_model,
            model_tts: cfg.tts_model,
          };
    try {
      await writeActivityLog(row);
    } catch {
      /* swallow */
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      const header = buildWavHeader({
        pcmByteLength: STREAMING_DATA_SIZE,
        sampleRate: PCM_SAMPLE_RATE_HZ,
        channels: 1,
        bitsPerSample: 16,
      });
      controller.enqueue(new Uint8Array(header));

      try {
        while (true) {
          const next = await iterator.next();
          if (next.done === true) break;
          controller.enqueue(new Uint8Array(next.value));
        }
        controller.close();
        await finishLog('ok', null);
      } catch (err) {
        const message =
          err instanceof OpenRouterError
            ? err.message
            : err instanceof Error
            ? err.message
            : String(err);
        await finishLog('error', message);
        controller.error(err);
      }
    },
    cancel: async (reason) => {
      if (typeof iterator.return === 'function') {
        try {
          await iterator.return(reason);
        } catch {
          /* ignore */
        }
      }
      await finishLog('error', reason instanceof Error ? reason.message : 'client_cancelled');
    },
  });

  const headers = new Headers({
    'Content-Type': 'audio/wav',
    'X-BMO-Reply-Text': encodeReplyHeader(thoughtText, REPLY_HEADER_CHAR_CAP),
    'X-BMO-Thought': '1',
    'X-BMO-Volume': String(cfg.volume),
    'X-Accel-Buffering': 'no',
    'Cache-Control': 'no-store',
    'Transfer-Encoding': 'chunked',
  });

  return new Response(stream, { status: 200, headers });
}

export async function POST(req: Request): Promise<Response> {
  return handle(req);
}

/**
 * GET handler so the device can trigger an idle thought with a plain GET (and
 * so it can be poked from a browser during testing). Shares the same auth +
 * pipeline as POST.
 */
export async function GET(req: Request): Promise<Response> {
  return handle(req);
}
