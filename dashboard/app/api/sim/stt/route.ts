import 'server-only';

import { Buffer } from 'node:buffer';

import { requireAdmin } from '@/lib/api-auth';
import { getConfig } from '@/lib/config';
import { OpenRouterError, transcribe } from '@/lib/openrouter';

/**
 * POST /api/sim/stt — simulator speech-to-text stage.
 *
 * Browser-facing twin of `/api/voice/stt`. Authenticated by the admin
 * session cookie (NOT the firmware fingerprint) because it is called from
 * the dashboard's end-to-end simulator page, not the device.
 *
 * Accepts a raw audio body (whatever MediaRecorder produced, usually
 * `audio/webm`) and returns JSON `{ text, ms, model }` so the simulator can
 * render a per-stage status indicator with latency. On failure returns
 * `{ stage: 'stt', error }` with the upstream-attributed status.
 *
 * Unlike the firmware route, the simulator does NOT write activity_log rows:
 * it is a developer tool, and logging here would pollute the real device
 * traffic view.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

type WireFormat = 'wav' | 'mp3' | 'flac';

const CONTENT_TYPE_TO_FORMAT: ReadonlyMap<string, WireFormat> = new Map([
  ['audio/wav', 'wav'],
  ['audio/x-wav', 'wav'],
  ['audio/mpeg', 'mp3'],
  ['audio/mp3', 'mp3'],
  ['audio/webm', 'mp3'],
  ['audio/ogg', 'mp3'],
  ['audio/flac', 'flac'],
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

export async function POST(req: Request): Promise<Response> {
  const startedAt = Date.now();

  if (!(await requireAdmin(req))) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  const ct = parseContentType(req);
  const format = ct === null ? 'mp3' : (CONTENT_TYPE_TO_FORMAT.get(ct) ?? 'mp3');

  let arrayBuffer: ArrayBuffer;
  try {
    arrayBuffer = await req.arrayBuffer();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid_body';
    return jsonResponse({ stage: 'stt', error: message }, 400);
  }
  if (arrayBuffer.byteLength === 0) {
    return jsonResponse({ stage: 'stt', error: 'empty_audio' }, 400);
  }
  if (arrayBuffer.byteLength > MAX_AUDIO_BYTES) {
    return jsonResponse({ stage: 'stt', error: 'payload_too_large' }, 413);
  }

  const cfg = await getConfig();
  try {
    const result = await transcribe({
      audio: Buffer.from(arrayBuffer),
      format,
      model: cfg.stt_model,
      signal: req.signal,
    });
    return jsonResponse(
      {
        text: result.text,
        ms: Date.now() - startedAt,
        model: cfg.stt_model,
        bytes: arrayBuffer.byteLength,
      },
      200,
    );
  } catch (err) {
    const message =
      err instanceof OpenRouterError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'unknown error';
    return jsonResponse({ stage: 'stt', error: message, ms: Date.now() - startedAt }, 502);
  }
}
