import 'server-only';

import { verifyFingerprint } from '@/app/api/_lib/fingerprint-guard';
import { writeActivityLog, type ActivityLogRow } from '@/app/api/_lib/log';
import { transcodeUrlToPcm16, AudioTranscodeError } from '@/lib/audio-transcode';
import { getConfig } from '@/lib/config';
import { getSong } from '@/lib/songs';
import { buildWavHeader } from '@/lib/wav';

/**
 * GET /api/voice/song?id=<song-id>
 *
 * Streams a song from the catalog to the firmware as PCM16 mono 24 kHz,
 * either raw or wrapped in a streaming WAV header (`?format=wav`).
 *
 * The audio file at `songs.url` may be MP3, OGG, WAV, FLAC, AAC — anything
 * ffmpeg can decode. We never expose the raw URL to the firmware; the
 * dashboard fetches and transcodes server-side, so the firmware still sees
 * the same wire format `/api/voice/tts` already speaks.
 *
 * Pre-stream errors (auth, missing id, song-not-found, fetch-fail before
 * any audio bytes) return JSON. Mid-stream errors close the connection
 * abruptly via `controller.error`. Exactly one `activity_log` row is
 * written in either case (logged with `type: 'tts'` so it shares the
 * existing schema; the row's `input_text` carries the song title for
 * legibility).
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Vercel function runtime cap, in seconds.
 *
 * Songs stream for the full playback duration. 60s is the Hobby plan max;
 * Pro plans can raise this up to 300s by editing this constant. Tracks
 * longer than the cap will be cut off mid-playback.
 */
export const maxDuration = 60;

const PCM_SAMPLE_RATE_HZ = 24_000;
const STREAMING_DATA_SIZE = 0xffffffff;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export async function GET(req: Request): Promise<Response> {
  const startedAt = Date.now();

  // ------------------- pre-flight auth --------------------------------------
  const guard = await verifyFingerprint(req);
  if (!guard.ok) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  // ------------------- parse query -----------------------------------------
  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  const format = url.searchParams.get('format') === 'wav' ? 'wav' : 'pcm16';
  if (id === null || id.length === 0) {
    return jsonResponse({ error: 'missing_id' }, 400);
  }

  const song = await getSong(id);
  if (song === null) {
    return jsonResponse({ error: 'not_found' }, 404);
  }

  // Load config so we can echo X-BMO-Volume.
  const cfg = await getConfig();

  // Single-shot logger so success and failure paths share the writer.
  let logged = false;
  async function logOutcome(
    status: 'ok' | 'error',
    errorMessage: string | null,
  ): Promise<void> {
    if (logged) return;
    logged = true;
    const row: ActivityLogRow =
      status === 'ok'
        ? {
            type: 'tts',
            input_text: `song:${song!.title}`,
            total_ms: Date.now() - startedAt,
            status: 'ok',
            model_tts: 'ffmpeg/pcm_s16le',
          }
        : {
            type: 'tts',
            input_text: `song:${song!.title}`,
            total_ms: Date.now() - startedAt,
            status: 'error',
            error_stage: 'tts',
            error_message: errorMessage ?? 'unknown',
            model_tts: 'ffmpeg/pcm_s16le',
          };
    try {
      await writeActivityLog(row);
    } catch {
      /* swallow */
    }
  }

  // ------------------- open the upstream transcode --------------------------
  let iterator: AsyncIterator<Buffer>;
  try {
    const it = transcodeUrlToPcm16({ url: song.url, signal: req.signal });
    iterator = it[Symbol.asyncIterator]();
  } catch (err) {
    const message =
      err instanceof AudioTranscodeError
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
          err instanceof AudioTranscodeError
            ? err.message
            : err instanceof Error
            ? err.message
            : String(err);
        await logOutcome('error', message);
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
    'X-BMO-Song-Title': encodeURIComponent(song.title),
    'X-BMO-Volume': String(cfg.volume),
  });

  return new Response(stream, { status: 200, headers });
}
