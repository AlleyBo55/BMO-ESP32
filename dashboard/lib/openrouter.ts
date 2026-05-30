import 'server-only';

import { Buffer } from 'node:buffer';

import { serverEnv } from '@/lib/env';

/**
 * OpenRouterService — the only module that talks to OpenRouter.
 *
 * Wraps four endpoints with a tight, typed surface:
 *
 *   - `chat`              POST /chat/completions   (60s budget)
 *   - `transcribe`        POST /audio/transcriptions (30s budget)
 *   - `synthesizeStream`  POST /chat/completions   (streaming SSE, 30s/chunk)
 *   - `fetchCredits`      GET  /credits            (10s budget)
 *
 * All errors throw {@link OpenRouterError} with the stage attribution. All
 * requests honor a caller-provided `AbortSignal` plus a per-call timeout via
 * an internal `AbortController`.
 *
 * No SDK dependency — native `fetch` / `AbortController` / `TextDecoder`.
 */

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

const TIMEOUT_CHAT_MS = 60_000;
const TIMEOUT_STT_MS = 30_000;
const TIMEOUT_TTS_CHUNK_MS = 30_000;
const TIMEOUT_CREDITS_MS = 10_000;
const TIMEOUT_EMBEDDING_MS = 15_000;

/** Stage labels mirror the activity-log error_stage enum, plus credits. */
export type OpenRouterStage = 'stt' | 'llm' | 'tts' | 'credits' | 'embedding';

/**
 * Thrown for every OpenRouter failure (HTTP non-2xx, parse failure, timeout).
 *
 * Callers attribute the failure to a stage so the activity log and the API
 * response carry the right `error_stage` value.
 */
export class OpenRouterError extends Error {
  constructor(
    public readonly stage: OpenRouterStage,
    public readonly status: number,
    message: string,
  ) {
    super(`[openrouter:${stage}] ${status}: ${message}`);
    this.name = 'OpenRouterError';
  }
}

/** A single OpenRouter / OpenAI-compatible function tool descriptor. */
export interface OpenRouterTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ChatRequest {
  model: string;
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  tools?: Array<OpenRouterTool>;
  /**
   * Hints which tools the model may invoke. Default behavior (`undefined`)
   * is provider-specific; OpenAI defaults to "auto", which is what we want.
   */
  toolChoice?: 'auto' | 'none' | 'required';
  signal?: AbortSignal | undefined;
}

/** A single tool invocation produced by the LLM. */
export interface ChatToolCall {
  /** Provider-assigned id of this call. */
  id: string;
  /** Tool name as declared in the request `tools` array. */
  name: string;
  /** JSON-decoded arguments object, or `null` if the model emitted invalid JSON. */
  arguments: Record<string, unknown> | null;
}

export interface ChatResponse {
  text: string;
  /** Empty when the model returned plain text. */
  toolCalls: ChatToolCall[];
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface TranscribeRequest {
  audio: Buffer;
  format: 'wav' | 'mp3' | 'flac';
  model: string;
  language?: string;
  signal?: AbortSignal | undefined;
}

export interface TranscribeResponse {
  text: string;
  durationSeconds?: number;
  costUsd?: number;
}

export interface SynthesizeStreamRequest {
  model: string;
  voice: string;
  text: string;
  systemPrompt?: string;
  /**
   * When true (default), the user text is wrapped in an explicit
   * "read this script verbatim" instruction. This is REQUIRED for the
   * chat-audio models (`gpt-audio-mini`) which otherwise treat the text as a
   * conversational turn and speak a *different* reply than what was sent —
   * the cause of "BMO says something other than the logged reply". Set to
   * false for singing, where the lyrics must be performed as-is without the
   * spoken-script framing.
   */
  verbatim?: boolean;
  signal?: AbortSignal | undefined;
}

export interface CreditsResponse {
  total: number;
  used: number;
  remaining: number;
  currency: 'USD';
  fetchedAt: number;
}

/* -------------------------------------------------------------------------- */
/* internal helpers                                                            */
/* -------------------------------------------------------------------------- */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${serverEnv.OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Returns `{ signal, cancel }` where `signal` aborts when:
 *   - `parent` aborts (if provided),
 *   - `timeoutMs` elapses, or
 *   - `cancel()` is called.
 *
 * `cancel()` always clears the timeout to avoid handle leaks.
 */
function makeTimedSignal(
  timeoutMs: number,
  parent: AbortSignal | undefined,
): { signal: AbortSignal; cancel: () => void; refresh: () => void } {
  const ctrl = new AbortController();
  let timer: NodeJS.Timeout | null = null;

  const onParentAbort = (): void => {
    ctrl.abort(parent?.reason);
  };

  const arm = (): void => {
    timer = setTimeout(() => {
      ctrl.abort(new Error('timeout'));
    }, timeoutMs);
  };

  const clear = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  if (parent !== undefined) {
    if (parent.aborted) {
      ctrl.abort(parent.reason);
    } else {
      parent.addEventListener('abort', onParentAbort, { once: true });
    }
  }
  arm();

  return {
    signal: ctrl.signal,
    cancel: () => {
      clear();
      if (parent !== undefined) {
        parent.removeEventListener('abort', onParentAbort);
      }
    },
    refresh: () => {
      clear();
      arm();
    },
  };
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.text();
    return body.length > 0 ? body : response.statusText;
  } catch {
    return response.statusText;
  }
}

function abortToError(err: unknown, stage: OpenRouterStage): OpenRouterError {
  if (err instanceof OpenRouterError) return err;
  const message = err instanceof Error ? err.message : String(err);
  // 0 conventionally signals a transport / abort / parse failure (no HTTP).
  return new OpenRouterError(stage, 0, message);
}

/* -------------------------------------------------------------------------- */
/* chat                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Non-streaming chat completion. Throws {@link OpenRouterError} on any
 * non-2xx response, transport error, abort, or 60s timeout.
 */
export async function chat(req: ChatRequest): Promise<ChatResponse> {
  const timed = makeTimedSignal(TIMEOUT_CHAT_MS, req.signal);
  const body: Record<string, unknown> = {
    model: req.model,
    messages: [
      { role: 'system', content: req.systemPrompt },
      ...req.messages,
    ],
  };
  if (req.tools !== undefined && req.tools.length > 0) {
    body.tools = req.tools;
    body.tool_choice = req.toolChoice ?? 'auto';
  }

  let response: Response;
  try {
    response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: timed.signal,
    });
  } catch (err) {
    timed.cancel();
    throw abortToError(err, 'llm');
  }

  if (!response.ok) {
    const msg = await readErrorMessage(response);
    timed.cancel();
    throw new OpenRouterError('llm', response.status, msg);
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (err) {
    timed.cancel();
    throw abortToError(err, 'llm');
  }
  timed.cancel();

  if (!isRecord(parsed)) {
    throw new OpenRouterError('llm', response.status, 'response was not a JSON object');
  }

  const choices = parsed.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new OpenRouterError('llm', response.status, 'response had no choices');
  }
  const first = choices[0];
  if (!isRecord(first) || !isRecord(first.message)) {
    throw new OpenRouterError('llm', response.status, 'first choice missing message');
  }
  const content = first.message.content;
  const text = typeof content === 'string' ? content : '';

  const toolCalls: ChatToolCall[] = [];
  if (Array.isArray(first.message.tool_calls)) {
    for (const candidate of first.message.tool_calls) {
      if (!isRecord(candidate)) continue;
      if (typeof candidate.id !== 'string' || candidate.id.length === 0) continue;
      const fn = candidate.function;
      if (!isRecord(fn) || typeof fn.name !== 'string' || fn.name.length === 0) {
        continue;
      }
      let args: Record<string, unknown> | null = null;
      if (typeof fn.arguments === 'string' && fn.arguments.length > 0) {
        try {
          const decoded = JSON.parse(fn.arguments);
          if (isRecord(decoded)) args = decoded;
        } catch {
          args = null;
        }
      } else if (isRecord(fn.arguments)) {
        args = fn.arguments as Record<string, unknown>;
      }
      toolCalls.push({ id: candidate.id, name: fn.name, arguments: args });
    }
  }

  const out: ChatResponse = { text, toolCalls };
  const usage = parsed.usage;
  if (isRecord(usage)) {
    if (typeof usage.prompt_tokens === 'number') out.inputTokens = usage.prompt_tokens;
    if (typeof usage.completion_tokens === 'number') out.outputTokens = usage.completion_tokens;
    if (typeof usage.total_cost === 'number') out.costUsd = usage.total_cost;
    else if (typeof usage.cost === 'number') out.costUsd = usage.cost;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* transcribe                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Transcribes a single audio buffer. The caller must pass already-wrapped
 * audio (e.g. WAV with RIFF header for `format='wav'`). The buffer is
 * base64-encoded into the request body.
 */
export async function transcribe(req: TranscribeRequest): Promise<TranscribeResponse> {
  const timed = makeTimedSignal(TIMEOUT_STT_MS, req.signal);
  const body: Record<string, unknown> = {
    model: req.model,
    input_audio: {
      data: req.audio.toString('base64'),
      format: req.format,
    },
  };
  if (req.language !== undefined) {
    body.language = req.language;
  }

  let response: Response;
  try {
    response = await fetch(`${OPENROUTER_BASE_URL}/audio/transcriptions`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: timed.signal,
    });
  } catch (err) {
    timed.cancel();
    throw abortToError(err, 'stt');
  }

  if (!response.ok) {
    const msg = await readErrorMessage(response);
    timed.cancel();
    throw new OpenRouterError('stt', response.status, msg);
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (err) {
    timed.cancel();
    throw abortToError(err, 'stt');
  }
  timed.cancel();

  if (!isRecord(parsed) || typeof parsed.text !== 'string') {
    throw new OpenRouterError('stt', response.status, 'response missing "text" field');
  }
  const out: TranscribeResponse = { text: parsed.text };
  if (typeof parsed.duration === 'number') out.durationSeconds = parsed.duration;
  else if (typeof parsed.duration_seconds === 'number') out.durationSeconds = parsed.duration_seconds;
  if (typeof parsed.cost === 'number') out.costUsd = parsed.cost;
  return out;
}

/* -------------------------------------------------------------------------- */
/* synthesizeStream                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Yields raw PCM16 mono 24 kHz chunks from an OpenRouter chat-completion
 * stream configured for audio output. The 30s timeout resets on every chunk
 * so a slow-but-steady stream is permitted; a stalled stream still aborts.
 *
 * SSE frames look like `data: {json}\n\n`. The final frame is `data: [DONE]`.
 * Audio bytes arrive base64-encoded under `choices[0].delta.audio.data`.
 */
export async function* synthesizeStream(
  req: SynthesizeStreamRequest,
): AsyncIterable<Buffer> {
  const timed = makeTimedSignal(TIMEOUT_TTS_CHUNK_MS, req.signal);
  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
  if (req.systemPrompt !== undefined && req.systemPrompt.length > 0) {
    messages.push({ role: 'system', content: req.systemPrompt });
  }
  // For verbatim speech (default), wrap the text so the chat-audio model can't
  // mistake it for a prompt to answer — it must read EXACTLY these words. The
  // delimiters keep the model from speaking the instruction itself. Singing
  // passes verbatim:false so the lyrics aren't wrapped.
  const verbatim = req.verbatim !== false;
  const userContent = verbatim
    ? `Read this text aloud exactly as written, word for word, and say nothing else:\n\n"""\n${req.text}\n"""`
    : req.text;
  messages.push({ role: 'user', content: userContent });

  const body = {
    model: req.model,
    modalities: ['text', 'audio'],
    audio: { voice: req.voice, format: 'pcm16' },
    stream: true,
    messages,
  };

  let response: Response;
  try {
    response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { ...authHeaders(), Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: timed.signal,
    });
  } catch (err) {
    timed.cancel();
    throw abortToError(err, 'tts');
  }

  if (!response.ok) {
    const msg = await readErrorMessage(response);
    timed.cancel();
    throw new OpenRouterError('tts', response.status, msg);
  }

  if (response.body === null) {
    timed.cancel();
    throw new OpenRouterError('tts', response.status, 'response had no body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        throw abortToError(err, 'tts');
      }
      if (chunk.done) break;
      timed.refresh();

      buffer += decoder.decode(chunk.value, { stream: true });

      // Process any complete SSE events terminated by a blank line.
      let separatorIdx = buffer.indexOf('\n\n');
      while (separatorIdx !== -1) {
        const rawEvent = buffer.slice(0, separatorIdx);
        buffer = buffer.slice(separatorIdx + 2);
        separatorIdx = buffer.indexOf('\n\n');

        // An SSE event may contain multiple `data:` lines; OpenRouter sends
        // one per event. Concatenate per the SSE spec.
        const dataLines: string[] = [];
        for (const line of rawEvent.split('\n')) {
          if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart());
          }
        }
        if (dataLines.length === 0) continue;
        const dataPayload = dataLines.join('\n');
        if (dataPayload === '[DONE]') {
          return;
        }

        let event: unknown;
        try {
          event = JSON.parse(dataPayload);
        } catch {
          // Malformed JSON in a stream frame: skip rather than abort the
          // whole synthesis. Real OpenRouter frames are well-formed.
          continue;
        }

        const audioB64 = extractAudioB64(event);
        if (audioB64 !== null && audioB64.length > 0) {
          yield Buffer.from(audioB64, 'base64');
        }
      }
    }
  } finally {
    timed.cancel();
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

function extractAudioB64(event: unknown): string | null {
  if (!isRecord(event)) return null;
  const choices = event.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!isRecord(first)) return null;
  const delta = first.delta;
  if (!isRecord(delta)) return null;
  const audio = delta.audio;
  if (!isRecord(audio)) return null;
  const data = audio.data;
  return typeof data === 'string' ? data : null;
}

/* -------------------------------------------------------------------------- */
/* fetchCredits                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Fetches the OpenRouter credit balance. Computes `remaining = total - used`.
 *
 * OpenRouter currently returns `{ data: { total_credits, total_usage } }`.
 * We narrow defensively in case the wrapper changes.
 */
export async function fetchCredits(): Promise<CreditsResponse> {
  const timed = makeTimedSignal(TIMEOUT_CREDITS_MS, undefined);

  let response: Response;
  try {
    response = await fetch(`${OPENROUTER_BASE_URL}/credits`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${serverEnv.OPENROUTER_API_KEY}` },
      signal: timed.signal,
    });
  } catch (err) {
    timed.cancel();
    throw abortToError(err, 'credits');
  }

  if (!response.ok) {
    const msg = await readErrorMessage(response);
    timed.cancel();
    throw new OpenRouterError('credits', response.status, msg);
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (err) {
    timed.cancel();
    throw abortToError(err, 'credits');
  }
  timed.cancel();

  if (!isRecord(parsed) || !isRecord(parsed.data)) {
    throw new OpenRouterError('credits', response.status, 'response missing "data" object');
  }
  const data = parsed.data;
  const total = typeof data.total_credits === 'number' ? data.total_credits : null;
  const used = typeof data.total_usage === 'number' ? data.total_usage : null;
  if (total === null || used === null) {
    throw new OpenRouterError(
      'credits',
      response.status,
      'response missing total_credits or total_usage',
    );
  }
  return {
    total,
    used,
    remaining: total - used,
    currency: 'USD',
    fetchedAt: Date.now(),
  };
}

/* -------------------------------------------------------------------------- */
/* embeddings                                                                  */
/* -------------------------------------------------------------------------- */

export interface EmbedRequest {
  /** Embedding model id, e.g. `openai/text-embedding-3-small`. */
  model: string;
  /** One or more strings to embed. */
  input: string | string[];
  /**
   * Optional output dimensionality. For `text-embedding-3-*` models this
   * truncates the vector to the requested size; it MUST match the column
   * width in `brain_memory` (1536).
   */
  dimensions?: number;
  signal?: AbortSignal | undefined;
}

export interface EmbedResponse {
  /** One embedding per input string, in input order. */
  embeddings: number[][];
  costUsd?: number;
}

/**
 * Generates embeddings via OpenRouter's OpenAI-compatible `/embeddings`
 * endpoint. Throws {@link OpenRouterError} (stage `'embedding'`) on any
 * non-2xx response, transport error, abort, or 15s timeout.
 *
 * Used by the brain memory layer (`lib/brain.ts`) for semantic recall and
 * capture. Kept here so OpenRouter remains the single egress point.
 */
export async function embed(req: EmbedRequest): Promise<EmbedResponse> {
  const timed = makeTimedSignal(TIMEOUT_EMBEDDING_MS, req.signal);
  const body: Record<string, unknown> = {
    model: req.model,
    input: req.input,
  };
  if (req.dimensions !== undefined) {
    body.dimensions = req.dimensions;
  }

  let response: Response;
  try {
    response = await fetch(`${OPENROUTER_BASE_URL}/embeddings`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: timed.signal,
    });
  } catch (err) {
    timed.cancel();
    throw abortToError(err, 'embedding');
  }

  if (!response.ok) {
    const msg = await readErrorMessage(response);
    timed.cancel();
    throw new OpenRouterError('embedding', response.status, msg);
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (err) {
    timed.cancel();
    throw abortToError(err, 'embedding');
  }
  timed.cancel();

  if (!isRecord(parsed) || !Array.isArray(parsed.data)) {
    throw new OpenRouterError('embedding', response.status, 'response missing "data" array');
  }

  const embeddings: number[][] = [];
  for (const item of parsed.data) {
    if (!isRecord(item) || !Array.isArray(item.embedding)) {
      throw new OpenRouterError('embedding', response.status, 'data item missing "embedding"');
    }
    const vec = item.embedding.filter((n): n is number => typeof n === 'number');
    if (vec.length === 0) {
      throw new OpenRouterError('embedding', response.status, 'embedding vector was empty');
    }
    embeddings.push(vec);
  }
  if (embeddings.length === 0) {
    throw new OpenRouterError('embedding', response.status, 'no embeddings returned');
  }

  const out: EmbedResponse = { embeddings };
  const usage = parsed.usage;
  if (isRecord(usage)) {
    if (typeof usage.total_cost === 'number') out.costUsd = usage.total_cost;
    else if (typeof usage.cost === 'number') out.costUsd = usage.cost;
  }
  return out;
}
