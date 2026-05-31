import 'server-only';

import { Buffer } from 'node:buffer';

import { after } from 'next/server';

import { verifyFingerprint } from '@/app/api/_lib/fingerprint-guard';
import { writeActivityLog, type ActivityLogRow } from '@/app/api/_lib/log';
import { transcodeUrlToPcm16, AudioTranscodeError } from '@/lib/audio-transcode';
import { captureExchange, formatRecallForPrompt, recall, recentTurns } from '@/lib/brain';
import { getConfig } from '@/lib/config';
import {
  chat,
  OpenRouterError,
  synthesizeSpeech,
  synthesizeStream,
  transcribe,
  type OpenRouterTool,
} from '@/lib/openrouter';
import { findSongByTitle, listSongs } from '@/lib/songs';
import type { BmoConfig, Song } from '@/lib/types';
import {
  BMO_SINGING_DIRECTION,
  BMO_SPEECH_INSTRUCTIONS,
  BMO_SPEECH_MODEL,
  buildSingTool,
  extractSingLyrics,
  toSpeakableText,
} from '@/lib/voice';
import { applyRadioFx } from '@/lib/voice-fx';
import { buildWavHeader } from '@/lib/wav';

/**
 * POST /api/brain — the headline pipeline.
 *
 * Pipeline (audio path):  STT  →  LLM  →  streaming TTS
 * Pipeline (text path):         LLM  →  streaming TTS
 *
 *   1. Verify `X-BMO-Fingerprint` (401 on miss).
 *   2. Detect input mode by Content-Type:
 *        - `application/json`        → text-input mode, body `{ text }`
 *        - `multipart/form-data`     → audio-input mode, field `audio`
 *   3. If audio: cap at 25 MiB (413), call `transcribe()` to get the
 *      transcript. Otherwise use the supplied text directly.
 *   4. Load the soul + skill toggles from `getConfig()`.
 *   5. Call `chat()` with the soul as system prompt.
 *   6. Open `synthesizeStream()` and pipe PCM16 chunks back to the caller,
 *      prefixed with a streaming-WAV header (dataSize = 0xFFFFFFFF).
 *
 *   - Per-stage error attribution via 502 + `{ stage }`.
 *   - Mid-stream TTS errors close the connection abruptly via
 *     `controller.error`; the activity log row records `status: 'error'`.
 *   - Single activity log row in `finally` regardless of failure stage
 *     (Property 20).
 *
 * Response headers:
 *   Content-Type:            audio/wav   (streaming WAV header included)
 *   X-BMO-Reply-Text:        first 1 KB of the reply, URL-encoded
 *   X-Accel-Buffering:       no
 *   Cache-Control:           no-store
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Vercel function runtime cap, in seconds.
 *
 * The brain pipeline streams audio for the full duration of the LLM reply
 * (or the picked song), so the function must stay alive that whole time.
 * 60s is the maximum for Vercel Hobby/Pro free; Pro plans can raise this
 * up to 300s. The brain `TOTAL_BUDGET_MS` aborts the pipeline at 60s
 * regardless, so this number stays in sync with that.
 */
export const maxDuration = 60;

/** PCM16 sample rate produced by OpenRouter audio output. */
const PCM_SAMPLE_RATE_HZ = 24_000;

/** "Streaming WAV" sentinel for tolerant decoders. */
const STREAMING_DATA_SIZE = 0xffffffff;

/** Hard cap on inbound audio body. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/** Total budget across all three stages. */
const TOTAL_BUDGET_MS = 60_000;

/** Cap on the X-BMO-Reply-Text header value (pre-URL-encoding). */
const REPLY_HEADER_CHAR_CAP = 1024;

/**
 * Synthetic user turn used when STT hears no intelligible speech (silence, a
 * cough, room noise). We can't know the child's language from empty audio, so
 * instead of a hardcoded foreign string we ask the model — running under the
 * dashboard soul — to produce a short "didn't catch that" nudge IN THE SOUL'S
 * OWN LANGUAGE/PERSONA. This is a meta-instruction to the model, never spoken.
 */
const NO_SPEECH_NUDGE =
  '(The child held the talk button but no clear speech was captured — only silence or noise. ' +
  'In your own voice and in the language your persona speaks, say one short, warm sentence ' +
  "letting them know you didn't catch it and to try again. Do not ask what they said as if you " +
  'heard words; just gently invite them to repeat.)';

/** Last-resort line if the model returns nothing for the no-speech nudge. */
const NO_SPEECH_FALLBACK = 'Hmm? Coba bilang lagi ya!';

/**
 * Builds a "current time in Indonesia (WIB)" context line so BMO answers
 * time questions correctly instead of hallucinating ("jam 3 sore" at 11am).
 * The device has no clock/timezone; the server knows the real UTC time, which
 * we render in Asia/Jakarta. Recomputed per request so it's always current.
 *
 * This is dynamic runtime data (the live clock) the soul markdown can't carry,
 * so it's the one thing we still append. It does NOT dictate language or
 * persona — that all comes from the soul.
 */
function timeContext(): string {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `\n\n[CURRENT TIME]
Right now in Indonesia (WIB / Asia/Jakarta) it is: ${fmt.format(now)}.
If the child asks the time, date, or day, answer from THIS — never guess or invent a time.
[/CURRENT TIME]`;
}

/**
 * The system prompt is the dashboard-editable soul, verbatim — it is the
 * SINGLE source of truth for persona, language, and style. Edit the soul on
 * the dashboard to change how BMO talks (including what language it replies
 * in). The only thing appended is the live clock (timeContext), which is
 * runtime data the soul can't carry and which never dictates language/persona.
 */
function buildSystemPrompt(soulMd: string): string {
  return soulMd + timeContext();
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

function parseContentType(req: Request): string | null {
  const raw = req.headers.get('content-type');
  if (raw === null) return null;
  const semi = raw.indexOf(';');
  return (semi === -1 ? raw : raw.slice(0, semi)).trim().toLowerCase();
}

/**
 * Maps an audio MIME type to the OpenRouter `format` field. Falls back to
 * `'wav'` when the type is unknown — the firmware always sends WAV.
 */
function mimeToFormat(mime: string | null): 'wav' | 'mp3' | 'flac' {
  if (mime === null) return 'wav';
  const t = mime.toLowerCase();
  if (t.startsWith('audio/wav')) return 'wav';
  if (t.startsWith('audio/x-wav')) return 'wav';
  if (t.startsWith('audio/mpeg')) return 'mp3';
  if (t.startsWith('audio/mp3')) return 'mp3';
  if (t.startsWith('audio/flac')) return 'flac';
  if (t.startsWith('audio/webm')) return 'mp3';
  return 'wav';
}

/**
 * Computes the OpenRouter `tools` array exposed to the LLM.
 *
 * Two tools may be wired:
 *   - `sing`: exposed when the `sing` skill is enabled. Lets BMO perform a
 *     short, made-up song live in its own singing voice (the brain route
 *     synthesizes the `lyrics` with {@link BMO_SINGING_DIRECTION}).
 *   - `play_song`: exposed when the `play_music` skill is enabled AND the
 *     songs catalog is non-empty. Streams a real recording from the catalog.
 *
 * The `play_song` `title` argument is constrained to a string `enum` of the
 * actual catalog titles so the model cannot hallucinate a song that does not
 * exist. The brain route handles each call by either synthesizing the sung
 * lyrics or streaming the matching song's PCM16 instead of plain speech.
 */
function buildTools(cfg: BmoConfig, songs: Song[]): OpenRouterTool[] {
  const tools: OpenRouterTool[] = [];

  const sing = cfg.skills.sing;
  if (sing !== undefined && sing.enabled) {
    tools.push(buildSingTool());
  }

  const playMusic = cfg.skills.play_music;
  if (playMusic !== undefined && playMusic.enabled && songs.length > 0) {
    const titles = songs.map((s) => s.title);
    tools.push({
      type: 'function',
      function: {
        name: 'play_song',
        description:
          'Play a real recorded song from the curated catalog through the BMO speaker. Use this when the user asks to play a specific real song or piece of music that exists in the catalog. Match the user request to the closest title from the enum. To instead have BMO sing a short song in its own voice, use the `sing` tool.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['title'],
          properties: {
            title: {
              type: 'string',
              description: 'The exact catalog title of the song to play.',
              enum: titles,
            },
          },
        },
      },
    });
  }
  return tools;
}

interface ResolvedTranscript {
  text: string;
  /** Whether STT actually ran (false for the JSON text-input path). */
  ranStt: boolean;
}

/**
 * Reads the request body and returns the user transcript. For text-input
 * mode this is the body text; for audio-input mode this is the STT result.
 *
 * Throws an object whose `stage` field signals which pipeline stage failed,
 * so the caller can produce a stage-attributed JSON 502.
 */
async function resolveTranscript(
  req: Request,
  cfg: BmoConfig,
  signal: AbortSignal,
): Promise<ResolvedTranscript> {
  const ct = parseContentType(req);

  if (ct === 'application/json') {
    let parsed: unknown;
    try {
      parsed = await req.json();
    } catch {
      throw { stage: 'input', status: 400, message: 'invalid_json' };
    }
    if (!isRecord(parsed) || typeof parsed.text !== 'string' || parsed.text.length === 0) {
      throw { stage: 'input', status: 400, message: 'invalid_body' };
    }
    return { text: parsed.text, ranStt: false };
  }

  if (ct === 'multipart/form-data') {
    const declared = req.headers.get('content-length');
    if (declared !== null) {
      const n = Number.parseInt(declared, 10);
      if (Number.isFinite(n) && n > MAX_AUDIO_BYTES) {
        throw { stage: 'input', status: 413, message: 'payload_too_large' };
      }
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'invalid_form';
      throw { stage: 'input', status: 400, message: msg };
    }
    const audio = form.get('audio');
    if (audio === null || typeof audio === 'string') {
      throw { stage: 'input', status: 400, message: 'missing_audio_field' };
    }
    if (audio.size > MAX_AUDIO_BYTES) {
      throw { stage: 'input', status: 413, message: 'payload_too_large' };
    }

    const arrayBuffer = await audio.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);
    const audioMime = audio.type.length > 0 ? audio.type : null;
    try {
      const result = await transcribe({
        audio: buf,
        format: mimeToFormat(audioMime),
        model: cfg.stt_model,
        signal,
      });
      return { text: result.text, ranStt: true };
    } catch (err) {
      const msg =
        err instanceof OpenRouterError
          ? err.message
          : err instanceof Error
          ? err.message
          : 'unknown error';
      throw { stage: 'stt', status: 502, message: msg };
    }
  }

  throw { stage: 'input', status: 415, message: 'unsupported_media_type' };
}

interface PipelineError {
  stage: 'input' | 'stt' | 'llm' | 'tts';
  status: number;
  message: string;
}

function asPipelineError(err: unknown): PipelineError {
  if (
    isRecord(err) &&
    typeof err.stage === 'string' &&
    typeof err.status === 'number' &&
    typeof err.message === 'string' &&
    (err.stage === 'input' ||
      err.stage === 'stt' ||
      err.stage === 'llm' ||
      err.stage === 'tts')
  ) {
    return { stage: err.stage, status: err.status, message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { stage: 'llm', status: 502, message };
}

/** ASCII-safe header value of at most `cap` source chars, URL-encoded. */
function encodeReplyHeader(text: string, cap: number): string {
  return encodeURIComponent(text.slice(0, cap));
}

export async function POST(req: Request): Promise<Response> {
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

  // ------------------- pre-stream pipeline ----------------------------------
  // STT (if audio) and LLM both run before we decide whether to start
  // streaming TTS. Failures here become 502 JSON, not half-open audio.
  let cfg: BmoConfig;
  let songs: Song[] = [];
  let transcriptText: string;
  let modelStt: string | null = null;
  let modelLlm: string | null = null;
  let modelTts: string | null = null;
  let replyText: string;
  let songToPlay: Song | null = null;
  let singLyrics: string | null = null;
  let memoryEnabled = false;

  try {
    cfg = await getConfig();
    modelStt = cfg.stt_model;
    modelLlm = cfg.llm_model;
    modelTts = cfg.tts_model;

    const resolved = await resolveTranscript(req, cfg, ac.signal);
    transcriptText = resolved.text;

    // Non-speech guard: when STT ran but heard nothing intelligible (silence,
    // a cough, background noise), it returns an empty/whitespace transcript.
    // Feeding that to the LLM produced a RANDOM reply (or an empty one that
    // streamed no audio → "BMO didn't respond"). Flag it so we skip the LLM
    // and speak a friendly canned line instead — BMO always says SOMETHING
    // relevant and the firmware never gets a silent stream.
    const noSpeech = resolved.ranStt && transcriptText.trim().length === 0;

    // Load the catalog only if the play_music skill is on. Saves one round
    // trip when the operator has disabled music entirely.
    const playMusicSkill = cfg.skills.play_music;
    if (playMusicSkill !== undefined && playMusicSkill.enabled) {
      try {
        songs = await listSongs();
      } catch {
        // Catalog read failures shouldn't kill the brain route; fall back
        // to no-tools mode and let the LLM speak normally.
        songs = [];
      }
    }

    // Brain-first lookup (gbrain pattern): before BMO answers, recall what
    // it already knows that's relevant to this turn, and fold it into the
    // system prompt. Gated on the `memory` skill. Fully degradable: recall()
    // returns [] on any failure, so the brain never blocks a reply.
    // Skipped entirely on a non-speech turn (nothing to recall/answer).
    let memoryBlock = '';
    const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    const memorySkill = cfg.skills.memory;
    if (!noSpeech && memorySkill !== undefined && memorySkill.enabled) {
      memoryEnabled = true;
      const [memories, profileLine, turns] = await Promise.all([
        recall(transcriptText, { signal: ac.signal }),
        // The durable child profile (gbrain "enrich the entity over time").
        // Best-effort: degrades to '' if the profile module/table is absent.
        import('@/lib/brain/profile')
          .then((m) => m.profileSummary())
          .catch(() => ''),
        // Short-term dialogue history (recency, not similarity) so BMO can
        // follow multi-turn exchanges — e.g. answer "merah" as a reply to its
        // own previous question, and remember a name the child JUST said even
        // before the async profile extraction has written it. 2h window keeps
        // a whole play session in scope while not dragging in stale chats.
        // Degrades to [] on any failure.
        recentTurns(8, 120),
      ]);
      memoryBlock = formatRecallForPrompt(memories);
      if (profileLine.length > 0) {
        memoryBlock += `\n\n[CHILD PROFILE]\n${profileLine}\n[/CHILD PROFILE]`;
      }
      // Turn the stored exchanges into real chat turns. Skip the most recent
      // one only if it exactly duplicates the incoming transcript (can happen
      // on a quick retry); otherwise BMO sees the full back-and-forth.
      for (const t of turns) {
        if (t.child.length > 0) history.push({ role: 'user', content: t.child });
        if (t.bmo.length > 0) history.push({ role: 'assistant', content: t.bmo });
      }
    }

    try {
      if (noSpeech) {
        // Non-speech turn (silence/noise). Don't run the normal answer flow,
        // but still go through the LLM with a synthetic nudge so the reply is
        // in the SOUL's language/persona (not a hardcoded foreign string).
        const reply = await chat({
          model: cfg.llm_model,
          systemPrompt: buildSystemPrompt(cfg.soul_md),
          messages: [{ role: 'user', content: NO_SPEECH_NUDGE }],
          signal: ac.signal,
        });
        replyText = reply.text.trim().length > 0 ? reply.text : NO_SPEECH_FALLBACK;
      } else {
        const webSearchSkill = cfg.skills.web_search;
        const reply = await chat({
          model: cfg.llm_model,
          systemPrompt: buildSystemPrompt(cfg.soul_md) + memoryBlock,
          messages: [...history, { role: 'user', content: transcriptText }],
          tools: buildTools(cfg, songs),
          webSearch: webSearchSkill !== undefined && webSearchSkill.enabled,
          signal: ac.signal,
        });
        replyText = reply.text;

        // If the model asked to sing, capture the lyrics. The singing path
        // synthesizes these with BMO's singing voice direction instead of
        // speaking reply.text. Takes precedence over play_song below only if
        // no real song was picked.
        singLyrics = extractSingLyrics(reply.toolCalls);

        // Resolve any play_song tool call to a real catalog row. We pick the
        // first valid one and ignore the rest; the LLM can still narrate over
        // the song via reply.text if it wants to.
        for (const call of reply.toolCalls) {
          if (call.name !== 'play_song') continue;
          const argTitle = call.arguments?.title;
          if (typeof argTitle !== 'string' || argTitle.length === 0) continue;
          const matched = await findSongByTitle(argTitle);
          if (matched !== null) {
            songToPlay = matched;
            break;
          }
        }
      }
    } catch (err) {
      const msg =
        err instanceof OpenRouterError
          ? err.message
          : err instanceof Error
          ? err.message
          : 'unknown error';
      throw { stage: 'llm', status: 502, message: msg };
    }
  } catch (err) {
    clearTimeout(budgetTimer);
    req.signal.removeEventListener('abort', onAbort);

    const pe = asPipelineError(err);
    // For 'input' (415, 413, 400) we don't bother logging — those didn't
    // engage the pipeline. For 'stt' / 'llm' we do.
    if (pe.stage === 'stt' || pe.stage === 'llm') {
      const failureRow: ActivityLogRow = {
        type: 'brain',
        total_ms: Date.now() - startedAt,
        status: 'error',
        error_stage: pe.stage,
        error_message: pe.message,
        ...(modelStt !== null ? { model_stt: modelStt } : {}),
        ...(modelLlm !== null ? { model_llm: modelLlm } : {}),
        ...(modelTts !== null ? { model_tts: modelTts } : {}),
      };
      try {
        await writeActivityLog(failureRow);
      } catch {
        /* swallow */
      }
    }

    if (pe.stage === 'input') {
      return jsonResponse({ error: pe.message }, pe.status);
    }
    return jsonResponse({ stage: pe.stage, error: pe.message }, pe.status);
  }

  // ------------------- branch: song path vs TTS path ------------------------
  // When the LLM picked a song from the catalog, we stream the transcoded
  // audio file straight to the firmware instead of speaking the reply text.
  // Wire format is identical (PCM16 24 kHz mono inside a streaming WAV
  // wrapper) so the firmware doesn't care which path produced the bytes.
  if (songToPlay !== null) {
    const songSelected = songToPlay;
    let songIterator: AsyncIterator<Buffer>;
    try {
      const it = transcodeUrlToPcm16({
        url: songSelected.url,
        signal: ac.signal,
      });
      songIterator = it[Symbol.asyncIterator]();
    } catch (err) {
      clearTimeout(budgetTimer);
      req.signal.removeEventListener('abort', onAbort);
      const message =
        err instanceof AudioTranscodeError
          ? err.message
          : err instanceof Error
          ? err.message
          : 'unknown error';
      const failureRow: ActivityLogRow = {
        type: 'brain',
        input_text: transcriptText,
        reply_text: `song:${songSelected.title}`,
        total_ms: Date.now() - startedAt,
        status: 'error',
        error_stage: 'tts',
        error_message: message,
        model_stt: cfg.stt_model,
        model_llm: cfg.llm_model,
        model_tts: 'ffmpeg/pcm_s16le',
      };
      try {
        await writeActivityLog(failureRow);
      } catch {
        /* swallow */
      }
      return jsonResponse({ stage: 'tts', error: message }, 502);
    }

    let songLogged = false;
    const finishSongLog = async (
      status: 'ok' | 'error',
      errorMessage: string | null,
    ): Promise<void> => {
      if (songLogged) return;
      songLogged = true;
      clearTimeout(budgetTimer);
      req.signal.removeEventListener('abort', onAbort);
      const row: ActivityLogRow =
        status === 'ok'
          ? {
              type: 'brain',
              input_text: transcriptText,
              reply_text: `song:${songSelected.title}`,
              total_ms: Date.now() - startedAt,
              status: 'ok',
              model_stt: cfg.stt_model,
              model_llm: cfg.llm_model,
              model_tts: 'ffmpeg/pcm_s16le',
            }
          : {
              type: 'brain',
              input_text: transcriptText,
              reply_text: `song:${songSelected.title}`,
              total_ms: Date.now() - startedAt,
              status: 'error',
              error_stage: 'tts',
              error_message: errorMessage ?? 'unknown',
              model_stt: cfg.stt_model,
              model_llm: cfg.llm_model,
              model_tts: 'ffmpeg/pcm_s16le',
            };
      try {
        await writeActivityLog(row);
      } catch {
        /* swallow */
      }

      // Auto-grow the brain for song requests too: remember what was asked
      // for and that BMO played it. Degradable; runs after the response.
      if (status === 'ok' && memoryEnabled) {
        const songTitle = songSelected.title;
        const askedText = transcriptText;
        after(async () => {
          await captureExchange(askedText, `Memutar lagu "${songTitle}".`);
        });
      }
    };

    const songStream = new ReadableStream<Uint8Array>({
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
            const next = await songIterator.next();
            if (next.done === true) break;
            controller.enqueue(new Uint8Array(next.value));
          }
          controller.close();
          await finishSongLog('ok', null);
        } catch (err) {
          const message =
            err instanceof AudioTranscodeError
              ? err.message
              : err instanceof Error
              ? err.message
              : String(err);
          await finishSongLog('error', message);
          controller.error(err);
        }
      },
      cancel: async (reason) => {
        if (typeof songIterator.return === 'function') {
          try {
            await songIterator.return(reason);
          } catch {
            /* ignore */
          }
        }
        await finishSongLog(
          'error',
          reason instanceof Error ? reason.message : 'client_cancelled',
        );
      },
    });

    const songHeaders = new Headers({
      'Content-Type': 'audio/wav',
      'X-BMO-Reply-Text': encodeReplyHeader(
        `🎵 ${songSelected.title}`,
        REPLY_HEADER_CHAR_CAP,
      ),
      'X-BMO-Song-Title': encodeURIComponent(songSelected.title),
      'X-BMO-Volume': String(cfg.volume),
      'X-Accel-Buffering': 'no',
      'Cache-Control': 'no-store',
      'Transfer-Encoding': 'chunked',
    });
    return new Response(songStream, { status: 200, headers: songHeaders });
  }

  // ------------------- open TTS stream eagerly ------------------------------
  // Two distinct synthesis paths:
  //   - SPEAKING (default): the dedicated /audio/speech TTS (synthesizeSpeech)
  //     reads the reply VERBATIM. A true TTS can't improvise, so the audio
  //     always matches the logged reply text — this fixes "BMO says something
  //     different than the reply box".
  //   - SINGING: keep the chat-audio model (synthesizeStream), which is the
  //     one that can actually perform a melody from the lyrics.
  const isSinging = singLyrics !== null;
  // Rewrite "BMO" → "Bimo" in the spoken text so TTS says "BeeMo", not letters.
  // (The logged reply keeps canonical "BMO".)
  const ttsText = toSpeakableText(isSinging ? singLyrics! : replyText);
  const voicedReplyText = isSinging ? `🎵 ${singLyrics!}` : replyText;

  let iterator: AsyncIterator<Buffer>;
  try {
    const source = isSinging
      ? synthesizeStream({
          model: cfg.tts_model,
          voice: cfg.tts_voice,
          text: ttsText,
          systemPrompt: BMO_SINGING_DIRECTION,
          verbatim: false,
          signal: ac.signal,
        })
      : synthesizeSpeech({
          model: BMO_SPEECH_MODEL,
          voice: cfg.tts_voice,
          text: ttsText,
          instructions: BMO_SPEECH_INSTRUCTIONS,
          signal: ac.signal,
        });
    const it = applyRadioFx(source);
    iterator = it[Symbol.asyncIterator]();
  } catch (err) {
    clearTimeout(budgetTimer);
    req.signal.removeEventListener('abort', onAbort);

    const message =
      err instanceof OpenRouterError
        ? err.message
        : err instanceof Error
        ? err.message
        : 'unknown error';
    const failureRow: ActivityLogRow = {
      type: 'brain',
      input_text: transcriptText,
      reply_text: replyText,
      total_ms: Date.now() - startedAt,
      status: 'error',
      error_stage: 'tts',
      error_message: message,
      model_stt: cfg.stt_model,
      model_llm: cfg.llm_model,
      model_tts: cfg.tts_model,
    };
    try {
      await writeActivityLog(failureRow);
    } catch {
      /* swallow */
    }
    return jsonResponse({ stage: 'tts', error: message }, 502);
  }

  // ------------------- streaming response ----------------------------------
  let logged = false;
  const cfgSnapshot = cfg;
  const finalTranscript = transcriptText;
  // When singing, log the sung lyrics (prefixed with 🎵) as the reply so the
  // activity log reflects what BMO actually voiced rather than the (often
  // empty) plain reply text that accompanied the tool call.
  const finalReply = voicedReplyText;

  const finishLog = async (
    status: 'ok' | 'error',
    errorMessage: string | null,
  ): Promise<void> => {
    if (logged) return;
    logged = true;
    clearTimeout(budgetTimer);
    req.signal.removeEventListener('abort', onAbort);

    const row: ActivityLogRow =
      status === 'ok'
        ? {
            type: 'brain',
            input_text: finalTranscript,
            reply_text: finalReply,
            total_ms: Date.now() - startedAt,
            status: 'ok',
            model_stt: cfgSnapshot.stt_model,
            model_llm: cfgSnapshot.llm_model,
            model_tts: cfgSnapshot.tts_model,
          }
        : {
            type: 'brain',
            input_text: finalTranscript,
            reply_text: finalReply,
            total_ms: Date.now() - startedAt,
            status: 'error',
            error_stage: 'tts',
            error_message: errorMessage ?? 'unknown',
            model_stt: cfgSnapshot.stt_model,
            model_llm: cfgSnapshot.llm_model,
            model_tts: cfgSnapshot.tts_model,
          };
    try {
      await writeActivityLog(row);
    } catch {
      /* swallow */
    }

    // Auto-grow the brain (gbrain pattern): on a successful exchange, write
    // the turn to memory so future calls can recall it. Runs via `after()`
    // so it never delays the audio response and survives the serverless
    // freeze. Capture is fully degradable and never throws.
    if (status === 'ok' && memoryEnabled) {
      after(async () => {
        await captureExchange(finalTranscript, finalReply);
      });
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
      await finishLog(
        'error',
        reason instanceof Error ? reason.message : 'client_cancelled',
      );
    },
  });

  const headers = new Headers({
    'Content-Type': 'audio/wav',
    'X-BMO-Reply-Text': encodeReplyHeader(voicedReplyText, REPLY_HEADER_CHAR_CAP),
    'X-BMO-Volume': String(cfg.volume),
    'X-Accel-Buffering': 'no',
    'Cache-Control': 'no-store',
    'Transfer-Encoding': 'chunked',
  });

  return new Response(stream, { status: 200, headers });
}
