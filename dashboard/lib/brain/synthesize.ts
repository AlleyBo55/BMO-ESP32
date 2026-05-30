import 'server-only';

import { recall, type RecalledMemory } from '@/lib/brain';
import { BRAIN_REASONING_MODEL, brainWarn } from '@/lib/brain/contracts';
import { chat } from '@/lib/openrouter';

/**
 * Synthesis with gap analysis — gbrain's headline `think` feature for BMO.
 *
 * The real gbrain (https://github.com/garrytan/gbrain) draws a hard line
 * between `search` (hand back the raw retrieved pages) and `think` (reason
 * over them and return a *synthesized* answer that also states, out loud,
 * what the brain does NOT yet know). The honest gap analysis is the whole
 * point: a brain that quietly papers over its blind spots can't be trusted
 * by the agent sitting on top of it.
 *
 * This module reproduces `think` on BMO's stack. The retrieval half is the
 * existing {@link recall} (Supabase pgvector); the reasoning half is one
 * constrained LLM call (`chat` against {@link BRAIN_REASONING_MODEL}) that is
 * instructed to (a) answer ONLY from the supplied memories, (b) cite which
 * memory numbers it leaned on, and (c) enumerate gaps / uncertainties. BMO is
 * an Indonesian-speaking child's toy, so the synthesized `answer` is written
 * in warm Bahasa Indonesia.
 *
 * Degradation discipline (the brain is an enhancement, never a hard
 * dependency): every failure path resolves to a safe, useful value and logs
 * via {@link brainWarn}. With no memories we return an honest "belum tahu"
 * result; on any LLM or JSON-parse failure we DEGRADE to the concatenated top
 * memories with a gap noting that synthesis itself failed. {@link think}
 * never throws.
 */

/** How many memories to pull before synthesizing. */
const RECALL_LIMIT = 8;

/** A synthesized answer plus its provenance and an explicit blind-spot list. */
export interface SynthesisResult {
  /** Warm Bahasa Indonesia answer, synthesized from memories (never raw dump on the happy path). */
  answer: string;
  /** Human-readable references for the memories the answer drew on. */
  citations: string[];
  /** What the brain does NOT know / is unsure about, stated honestly. */
  gaps: string[];
  /** Ids of the `brain_memory` rows actually cited, in citation order. */
  usedMemoryIds: string[];
}

/** Shape the LLM is asked to return, before defensive validation. */
interface RawSynthesis {
  answer: string;
  citations: number[];
  gaps: string[];
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Short ISO date (YYYY-MM-DD) or a gentle fallback for citation display. */
function formatWhen(createdAt: string): string {
  return createdAt.length >= 10 ? createdAt.slice(0, 10) : 'tanggal tak diketahui';
}

/** A single citation line, e.g. `[2] (2024-05-01) Child likes dinosaurs`. */
function formatCitation(memory: RecalledMemory, position: number): string {
  return `[${position}] (${formatWhen(memory.createdAt)}) ${memory.content}`;
}

/** Numbered memory block fed to the model; index+1 is the citable number. */
function formatMemoriesForPrompt(memories: RecalledMemory[]): string {
  return memories
    .map((m, i) => `${i + 1}. (${formatWhen(m.createdAt)}) ${m.content}`)
    .join('\n');
}

/**
 * Pulls the first balanced-looking JSON object out of an LLM reply. Tolerates
 * stray prose or ```json fences by slicing from the first `{` to the last `}`.
 * Returns null when nothing object-like is present.
 */
function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = text.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

/** Coerces an unknown value into a list of positive integer citation numbers. */
function parseCitationNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const item of value) {
    if (typeof item === 'number' && Number.isInteger(item) && item > 0) {
      out.push(item);
    } else if (typeof item === 'string' && /^\d+$/.test(item.trim())) {
      const n = Number.parseInt(item.trim(), 10);
      if (n > 0) out.push(n);
    }
  }
  return out;
}

/** Coerces an unknown value into a list of trimmed, non-empty strings. */
function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed.length > 0) out.push(trimmed);
    }
  }
  return out;
}

/**
 * Validates the model's reply into a {@link RawSynthesis}. Returns null when
 * the answer is missing/empty, which the caller treats as a synthesis failure.
 */
function parseSynthesis(text: string): RawSynthesis | null {
  const parsed = extractJsonObject(text);
  if (!isRecord(parsed)) return null;
  const answer = typeof parsed.answer === 'string' ? parsed.answer.trim() : '';
  if (answer.length === 0) return null;
  return {
    answer,
    citations: parseCitationNumbers(parsed.citations),
    gaps: parseStringArray(parsed.gaps),
  };
}

/**
 * Best-effort fallback when synthesis is unavailable: hand back the top
 * memories verbatim, cite them all, and flag honestly that the rangkuman
 * failed. Keeps {@link think} useful instead of empty on a degraded path.
 */
function degradeToRawMemories(memories: RecalledMemory[], reason: string): SynthesisResult {
  const body = memories.map((m, i) => `${i + 1}. ${m.content}`).join('\n');
  return {
    answer: `BMO belum sempat merangkum, tapi ini yang BMO ingat:\n${body}`,
    citations: memories.map((m, i) => formatCitation(m, i + 1)),
    gaps: [`Automatic synthesis failed (${reason}); these are BMO's raw memories without a summary.`],
    usedMemoryIds: memories.map((m) => m.id),
  };
}

function buildSystemPrompt(): string {
  return [
    'You are the "brain" layer (gbrain) for BMO, a friendly kids toy that speaks Indonesian.',
    'Your job is to SYNTHESIZE a single answer from the provided memories, not just read them back.',
    '',
    'STRICT RULES:',
    '1. Answer ONLY from the memories available below. Do not invent or add outside knowledge.',
    '2. List the memory numbers you actually used in the "citations" field.',
    '3. Honestly state what is NOT known or still uncertain in the "gaps" field, especially when the memories are insufficient to answer.',
    '4. Write the "answer" field in warm, gentle, kid-friendly Bahasa Indonesia (Indonesian). Only the answer text is Indonesian; everything else is structural.',
    '',
    'Return ONLY valid JSON in exactly this shape, with no other text and no code fences:',
    '{"answer": "<answer text in Indonesian>", "citations": [<memory numbers>], "gaps": ["<things not yet known>"]}',
  ].join('\n');
}

function buildUserMessage(query: string, memories: RecalledMemory[]): string {
  return [
    `Question: "${query}"`,
    '',
    'Available memories:',
    formatMemoriesForPrompt(memories),
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* think — synthesis + gap analysis                                            */
/* -------------------------------------------------------------------------- */

/**
 * Synthesizes a cited, gap-aware answer from BMO's memories for `query`.
 *
 * Recalls the top ~8 memories, then asks the reasoning model to answer only
 * from them and to list its blind spots. Always resolves:
 *   - no memories      → honest "belum tahu" result with an empty-memory gap;
 *   - LLM/parse failure → degraded result built from the raw memories.
 *
 * @param query  The question to think about.
 * @param signal Optional abort signal threaded into recall and the LLM call.
 */
export async function think(query: string, signal?: AbortSignal): Promise<SynthesisResult> {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return {
      answer: 'Hmm, BMO belum dengar pertanyaannya. Coba ceritakan lagi ya, BMO siap mendengarkan!',
      citations: [],
      gaps: ['No question was provided to answer.'],
      usedMemoryIds: [],
    };
  }

  const recallOptions: { limit: number; signal?: AbortSignal } = { limit: RECALL_LIMIT };
  if (signal !== undefined) recallOptions.signal = signal;
  const memories = await recall(trimmed, recallOptions);

  if (memories.length === 0) {
    return {
      answer:
        'Hmm, soal itu BMO belum tahu. BMO belum punya ingatan yang berhubungan, tapi BMO senang sekali kalau kamu mau cerita lebih banyak supaya BMO bisa belajar!',
      citations: [],
      gaps: ['No related memories yet.'],
      usedMemoryIds: [],
    };
  }

  let replyText: string;
  try {
    const req: Parameters<typeof chat>[0] = {
      model: BRAIN_REASONING_MODEL,
      systemPrompt: buildSystemPrompt(),
      messages: [{ role: 'user', content: buildUserMessage(trimmed, memories) }],
    };
    if (signal !== undefined) req.signal = signal;
    const res = await chat(req);
    replyText = res.text;
  } catch (err) {
    brainWarn('synthesize', err);
    return degradeToRawMemories(memories, 'panggilan LLM gagal');
  }

  const parsed = parseSynthesis(replyText);
  if (parsed === null) {
    brainWarn('synthesize', 'model reply was not valid synthesis JSON');
    return degradeToRawMemories(memories, 'balasan model tidak bisa dibaca');
  }

  // Map 1-based citation numbers back to memory ids; drop out-of-range or
  // duplicate references so provenance stays honest.
  const citations: string[] = [];
  const usedMemoryIds: string[] = [];
  const seen = new Set<number>();
  for (const n of parsed.citations) {
    if (seen.has(n)) continue;
    const memory = memories[n - 1];
    if (memory === undefined) continue;
    seen.add(n);
    citations.push(formatCitation(memory, n));
    usedMemoryIds.push(memory.id);
  }

  return {
    answer: parsed.answer,
    citations,
    gaps: parsed.gaps,
    usedMemoryIds,
  };
}
