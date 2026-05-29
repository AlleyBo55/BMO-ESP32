import 'server-only';

import { spawn, type ChildProcess } from 'node:child_process';

import ffmpegPath from 'ffmpeg-static';

/**
 * Streaming audio transcoder.
 *
 * Pipes the bytes from a remote audio URL (MP3, OGG, WAV, FLAC, AAC — anything
 * ffmpeg understands) into ffmpeg's stdin and yields PCM16 mono 24 kHz samples
 * out of stdout, one chunk at a time. The stream is fully back-pressured: we
 * pause the upstream fetch when ffmpeg's stdin can't keep up, and we abort the
 * whole pipeline if the caller's signal fires.
 *
 * Output format is identical to OpenRouter's TTS audio output, so the brain /
 * voice routes can splice transcoded songs into the existing PCM16 streaming
 * response without any wire-format changes on the firmware side.
 */

/** Sample rate / channels / depth match the firmware's expected PCM16 stream. */
const TARGET_SAMPLE_RATE_HZ = 24_000;
const TARGET_CHANNELS = 1;

/** How long to wait for ffmpeg to start before giving up. */
const FFMPEG_OPEN_TIMEOUT_MS = 15_000;

/** How long any single read/write may stall before we abort. */
const STALL_TIMEOUT_MS = 30_000;

export class AudioTranscodeError extends Error {
  public override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'AudioTranscodeError';
    this.cause = cause;
  }
}

export interface TranscodeRequest {
  url: string;
  signal?: AbortSignal;
}

function ffmpegBinary(): string {
  if (typeof ffmpegPath !== 'string' || ffmpegPath.length === 0) {
    throw new AudioTranscodeError(
      'ffmpeg binary not found. ffmpeg-static did not resolve a platform binary.',
    );
  }
  return ffmpegPath;
}

interface SpawnedFfmpeg {
  child: ChildProcess;
  stdoutIterable: AsyncIterable<Buffer>;
}

function spawnFfmpeg(): SpawnedFfmpeg {
  const args = [
    // Read piped audio from stdin.
    '-i', 'pipe:0',
    // No video.
    '-vn',
    // Mono.
    '-ac', String(TARGET_CHANNELS),
    // 24 kHz.
    '-ar', String(TARGET_SAMPLE_RATE_HZ),
    // PCM16 little-endian.
    '-f', 's16le',
    '-acodec', 'pcm_s16le',
    // Send PCM to stdout.
    'pipe:1',
  ];
  const child = spawn(ffmpegBinary(), args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (child.stdout === null || child.stdin === null) {
    throw new AudioTranscodeError('ffmpeg spawn returned null pipes');
  }
  return {
    child,
    stdoutIterable: child.stdout as unknown as AsyncIterable<Buffer>,
  };
}

/**
 * Fetches `url`, pipes its body into ffmpeg's stdin, and yields PCM16 chunks
 * from ffmpeg's stdout. Throws {@link AudioTranscodeError} on transport,
 * spawn, or transcode failure. Honors `signal` cooperatively.
 */
export async function* transcodeUrlToPcm16(
  req: TranscodeRequest,
): AsyncIterable<Buffer> {
  if (typeof req.url !== 'string' || req.url.length === 0) {
    throw new AudioTranscodeError('url is required');
  }

  // ------------------- fetch the source -----------------------------------
  let response: Response;
  try {
    const init: RequestInit = {
      method: 'GET',
      // Conservative caching policy: we fetch fresh every time so the
      // firmware always plays the current bytes at the URL.
      cache: 'no-store',
      // Identify ourselves so a misconfigured CDN doesn't reject as a bot.
      headers: { 'user-agent': 'bmo-dashboard/songs (+https://github.com/AlleyBo55/BMO-ESP32)' },
    };
    if (req.signal !== undefined) {
      init.signal = req.signal;
    }
    response = await fetch(req.url, init);
  } catch (err) {
    throw new AudioTranscodeError(
      `audio source fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  if (!response.ok) {
    throw new AudioTranscodeError(
      `audio source returned HTTP ${response.status} ${response.statusText}`,
    );
  }
  if (response.body === null) {
    throw new AudioTranscodeError('audio source returned an empty body');
  }

  // ------------------- spawn ffmpeg ---------------------------------------
  const { child, stdoutIterable } = spawnFfmpeg();
  const stdin = child.stdin;
  if (stdin === null) {
    throw new AudioTranscodeError('ffmpeg stdin unavailable after spawn');
  }

  let stderrTail = '';
  if (child.stderr !== null) {
    child.stderr.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      // Keep just the last KB so the error message stays short.
      stderrTail = (stderrTail + text).slice(-1024);
    });
  }

  let exited = false;
  let exitError: AudioTranscodeError | null = null;
  child.once('error', (err) => {
    exited = true;
    exitError = new AudioTranscodeError(
      `ffmpeg child error: ${err.message}`,
      err,
    );
  });
  child.once('exit', (code, signalName) => {
    exited = true;
    if (code !== null && code !== 0) {
      exitError = new AudioTranscodeError(
        `ffmpeg exited with code ${code}: ${stderrTail.trim() || '(no stderr)'}`,
      );
    } else if (signalName !== null) {
      exitError = new AudioTranscodeError(
        `ffmpeg killed by signal ${signalName}: ${stderrTail.trim() || '(no stderr)'}`,
      );
    }
  });

  // ------------------- pipe source → ffmpeg stdin in the background -------
  const reader = response.body.getReader();
  const onAbort = (): void => {
    try {
      reader.cancel('aborted').catch(() => {
        /* ignore */
      });
    } catch {
      /* ignore */
    }
    if (!exited) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
  };
  if (req.signal !== undefined) {
    if (req.signal.aborted) {
      onAbort();
    } else {
      req.signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  const pumpIntoFfmpeg = async (): Promise<void> => {
    try {
      while (!exited) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await Promise.race([
            reader.read(),
            new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
              setTimeout(
                () => reject(new AudioTranscodeError('source read stalled')),
                STALL_TIMEOUT_MS,
              );
            }),
          ]);
        } catch (err) {
          throw err instanceof AudioTranscodeError
            ? err
            : new AudioTranscodeError(
                `source read error: ${err instanceof Error ? err.message : String(err)}`,
                err,
              );
        }
        if (chunk.done) break;
        if (!stdin.writable) break;
        const ok = stdin.write(chunk.value);
        if (!ok) {
          await new Promise<void>((resolve) => stdin.once('drain', resolve));
        }
      }
    } finally {
      try {
        stdin.end();
      } catch {
        /* ignore */
      }
    }
  };

  // Run the pump but don't await it inline; we want to start consuming
  // ffmpeg stdout immediately so back-pressure flows correctly.
  const pumpPromise = pumpIntoFfmpeg().catch((err) => {
    if (!exited) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
    return err instanceof AudioTranscodeError
      ? err
      : new AudioTranscodeError(
          `pump failed: ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
  });

  // Wait at most `FFMPEG_OPEN_TIMEOUT_MS` for the first stdout chunk so a
  // misconfigured ffmpeg invocation doesn't hang the response forever.
  let firstChunkSeen = false;
  const openTimeout = setTimeout(() => {
    if (!firstChunkSeen) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
  }, FFMPEG_OPEN_TIMEOUT_MS);

  try {
    for await (const out of stdoutIterable) {
      firstChunkSeen = true;
      // ffmpeg stdout already arrives as Buffer in Node when stdio:'pipe',
      // but the stream-iterator typing is `AsyncIterable<unknown>` — narrow
      // here so the caller sees Buffer.
      const buf = Buffer.isBuffer(out) ? out : Buffer.from(out as Uint8Array);
      yield buf;
    }
  } finally {
    clearTimeout(openTimeout);
    if (req.signal !== undefined) {
      req.signal.removeEventListener('abort', onAbort);
    }
    // Drain the pump promise so its rejection (if any) is observed.
    const pumpResult = await pumpPromise;
    if (pumpResult instanceof AudioTranscodeError && exitError === null) {
      exitError = pumpResult;
    }
    if (!exited) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
  }

  if (exitError !== null) {
    throw exitError;
  }
}
