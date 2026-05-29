import 'server-only';

import { Buffer } from 'node:buffer';

import { verifyFingerprint } from '@/app/api/_lib/fingerprint-guard';
import { writeActivityLog, type ActivityLogRow } from '@/app/api/_lib/log';
import { getConfig } from '@/lib/config';
import { OpenRouterError, transcribe } from '@/lib/openrouter';

/**
 * POST /api/voice/stt
 *
 * Firmware-facing speech-to-text endpoint.
 *
 *   1. Verify `X-BMO-Fingerprint` (401 on miss).
 *   2. Validate content-type against the small allow-list (415 on miss).
 *   3. Reject bodies > 25 MiB before reading them (413).
 *   4. Pass the audio buffer to OpenRouter via `transcribe()`.
 *   5. Always write exactly one `activity_log` row in `finally`, regardless
 *      of success or stage of failure (Property 20).
 *
 * Response shape on success: `{ text, duration_ms, model }`.
 * Response shape on failure: `{ stage: 'stt', error }` with HTTP 502.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Hard cap on the request body, in bytes. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/**
 * The library's `TranscribeRequest.format` type. We mirror it locally so the
 * mapping table below stays well-typed without re-exporting from `openrouter`.
 */
type WireFormat = 'wav' | 'mp3' | 'flac';

/**
 * Allow-listed inbound content types and the format hint we pass to OpenRouter.
 * `audio/webm` is accepted at the gate per the wire-protocol spec; OpenRouter
 * tolerates webm through its 'mp3' decoder path well enough for the firmware
 * use case, so we map there.
 */
const CONTENT_TYPE_TO_FORMAT: ReadonlyMap<string, WireFormat> = new Map([
  ['audio/wav', 'wav'],
  ['audio/mpeg', 'mp3'],
  ['audio/webm', 'mp3'],
]);

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function parseContentType(req: Request): string | null {
  const raw = req.headers.get('content-type');
  if (raw === null) return null;
  const semi = raw.indexOf(';');
  return (semi === -1 ? raw : raw.slice(0, semi)).trim().toLowerCase();
}

function declaredContentLength(req: Request): number | null {
  const raw = req.headers.get('content-length');
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export async function POST(req: Request): Promise<Response> {
  const startedAt = Date.now();

  // ------------------- pre-flight auth --------------------------------------
  const guard = await verifyFingerprint(req);
  if (!guard.ok) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  // ------------------- content-type allow-list ------------------------------
  const ct = parseContentType(req);
  const format = ct === null ? undefined : CONTENT_TYPE_TO_FORMAT.get(ct);
  if (format === undefined) {
    return jsonResponse({ error: 'unsupported_media_type' }, 415);
  }

  // ------------------- size guard (Content-Length first) --------------------
  const declared = declaredContentLength(req);
  if (declared !== null && declared > MAX_AUDIO_BYTES) {
    return jsonResponse({ error: 'payload_too_large' }, 413);
  }

  // ------------------- pipeline ---------------------------------------------
  // Single log row written in `finally` so we never produce zero or two rows
  // regardless of which branch returns. (Property 20.)
  let logRow: ActivityLogRow = {
    type: 'stt',
    total_ms: 0,
    status: 'error',
    error_stage: 'stt',
    error_message: 'unknown',
  };
  let response: Response = jsonResponse({ stage: 'stt', error: 'unknown' }, 502);

  try {
    const arrayBuffer = await req.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_AUDIO_BYTES) {
      logRow = {
        type: 'stt',
        total_ms: Date.now() - startedAt,
        status: 'error',
        error_stage: 'stt',
        error_message: 'payload_too_large',
      };
      response = jsonResponse({ error: 'payload_too_large' }, 413);
      return response;
    }

    const audio = Buffer.from(arrayBuffer);
    const cfg = await getConfig();
    const sttModel = cfg.stt_model;

    try {
      const result = await transcribe({
        audio,
        format,
        model: sttModel,
        signal: req.signal,
      });

      const totalMs = Date.now() - startedAt;
      const durationMs =
        result.durationSeconds !== undefined
          ? Math.round(result.durationSeconds * 1000)
          : 0;

      logRow = {
        type: 'stt',
        input_text: result.text,
        total_ms: totalMs,
        status: 'ok',
        model_stt: sttModel,
      };

      response = jsonResponse(
        { text: result.text, duration_ms: durationMs, model: sttModel },
        200,
      );
    } catch (err) {
      const message =
        err instanceof OpenRouterError
          ? err.message
          : err instanceof Error
          ? err.message
          : 'unknown error';
      logRow = {
        type: 'stt',
        total_ms: Date.now() - startedAt,
        status: 'error',
        error_stage: 'stt',
        error_message: message,
        model_stt: sttModel,
      };
      response = jsonResponse({ stage: 'stt', error: message }, 502);
    }
  } catch (err) {
    // Body read or earlier infrastructure error.
    const message = err instanceof Error ? err.message : 'unknown error';
    logRow = {
      type: 'stt',
      total_ms: Date.now() - startedAt,
      status: 'error',
      error_stage: 'stt',
      error_message: message,
    };
    response = jsonResponse({ stage: 'stt', error: message }, 502);
  } finally {
    // Best-effort log write. Don't let a logging failure mask the API result.
    try {
      await writeActivityLog(logRow);
    } catch {
      /* swallow: log infrastructure failure must not change the response */
    }
  }

  return response;
}
