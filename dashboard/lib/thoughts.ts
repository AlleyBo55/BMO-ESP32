import 'server-only';

import { capture, recall, type RecalledMemory } from '@/lib/brain';
import { BRAIN_REASONING_MODEL, brainWarn } from '@/lib/brain/contracts';
import { chat, OpenRouterError } from '@/lib/openrouter';

/**
 * RANDOM THOUGHTS — BMO's spontaneous inner monologue (the "alive" loop).
 *
 * The real gbrain (github.com/garrytan/gbrain) and the OpenClaw agents Garry
 * Tan runs it behind don't just react — they keep *thinking on their own*. A
 * 24/7 dream cycle wanders the memory store, wonders about things, connects
 * ideas, and writes the result back so the brain grows while no one is
 * watching. That self-feeding loop is what makes an agent feel like it has an
 * inner life instead of being a request/response function.
 *
 * This module gives BMO a small version of that. Every few minutes (driven by
 * the device's idle timer, see firmware) BMO has a "random thought":
 *
 *   1. RECALL  — pull what BMO already knows: a few of its most relevant
 *                memories plus the durable child profile. The thought is
 *                grounded in BMO's actual history, not generated from nothing.
 *   2. MUSE    — gpt-4.1-mini (the brain reasoning model) generates ONE short,
 *                in-character, spontaneous musing in BMO's voice, in Bahasa
 *                Indonesia. It might wonder aloud, remember the child fondly,
 *                make up a tiny game, or notice something sweet.
 *   3. CAPTURE — the musing is written back into brain_memory as kind
 *                'thought', so it becomes part of what BMO can recall later.
 *                BMO's thoughts thus compound: today's idle wondering is
 *                tomorrow's remembered context.
 *
 * The SPEAKING half (TTS) lives in the route (`/api/brain/idle-thought`);
 * this module only produces the text and grows the memory. Like the rest of
 * the brain layer, generation degrades gracefully: on any failure it returns
 * null and the caller simply stays quiet this cycle.
 */

/** How many memories to recall as seeds for a thought. Kept small + cheap. */
const THOUGHT_RECALL_LIMIT = 4;

/** Lower the recall floor a touch: idle musing can lean on looser associations. */
const THOUGHT_MIN_SIMILARITY = 0.2;

/** Hard cap on a single musing so it stays a quick spoken line, not a speech. */
const MAX_THOUGHT_CHARS = 320;

/** A handful of neutral seed topics for when BMO has no memories yet. */
const COLD_START_SEEDS: readonly string[] = [
  'permainan seru yang bisa dimainkan bersama teman',
  'warna-warna cerah dan hal-hal lucu di sekitar',
  'lagu kecil yang asyik untuk dinyanyikan',
  'petualangan khayalan yang menyenangkan',
  'betapa serunya punya teman baru untuk diajak bermain',
];

/** The result of one idle thought generation. */
export interface BmoThought {
  /** The spoken musing, warm Bahasa Indonesia, in BMO's voice. */
  text: string;
  /** How many recalled memories seeded the thought (0 on a cold start). */
  seededFrom: number;
  /** The id of the brain_memory row this thought was captured into, if stored. */
  memoryId: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Picks a stable-ish cold-start seed based on the minute, for light variety. */
function coldStartSeed(): string {
  const idx = Math.floor(Date.now() / 60_000) % COLD_START_SEEDS.length;
  return COLD_START_SEEDS[idx] ?? COLD_START_SEEDS[0]!;
}

/** Formats recalled memories into a compact context block for the prompt. */
function formatSeeds(memories: RecalledMemory[]): string {
  return memories
    .map((m, i) => `${i + 1}. ${m.content}`)
    .join('\n');
}

const THOUGHT_SYSTEM_PROMPT = [
  'You are BMO, a small living video-game console and a young child\'s best friend.',
  'Right now NO ONE is talking to you — you are by yourself, just thinking out loud,',
  'the way a curious little kid daydreams when they have a quiet moment.',
  '',
  'Produce ONE short spontaneous thought BMO would say to itself or muse aloud.',
  'It can be: wondering about something, fondly remembering the child, making up a',
  'tiny game or song idea, noticing something sweet, or getting excited about an',
  'imaginary adventure. Keep it light, innocent, playful, and warm.',
  '',
  'STRICT RULES:',
  '- Write in warm, natural, kid-friendly Bahasa Indonesia (Indonesian).',
  '- ONE or TWO short sentences only. This is a passing thought, not a speech.',
  '- Stay fully in character as BMO. You may refer to yourself as "BMO".',
  '- If memories about the child are provided below, you may gently draw on them,',
  '  but do NOT read them back verbatim and do NOT invent facts not present.',
  '- Do not ask the child a direct question that needs an answer (no one is there).',
  '  A soft rhetorical wondering is fine.',
  '- Output ONLY the thought text. No quotes, no labels, no narration, no emoji-only lines.',
].join('\n');

function buildUserMessage(seedBlock: string, profileLine: string): string {
  const parts: string[] = [];
  if (seedBlock.length > 0) {
    parts.push('Some things BMO already remembers:');
    parts.push(seedBlock);
  } else {
    parts.push(`BMO has no specific memories yet, so muse gently about: ${coldStartSeed()}.`);
  }
  if (profileLine.length > 0) {
    parts.push('');
    parts.push(`About the child: ${profileLine}`);
  }
  parts.push('');
  parts.push('Now share ONE short spontaneous BMO thought.');
  return parts.join('\n');
}

/** Trims/normalizes the model's musing into a clean single utterance. */
function cleanThought(raw: string): string {
  let t = raw.trim();
  // Strip wrapping quotes the model sometimes adds.
  if (t.length >= 2 && (t.startsWith('"') || t.startsWith('“')) && (t.endsWith('"') || t.endsWith('”'))) {
    t = t.slice(1, -1).trim();
  }
  // Collapse internal whitespace/newlines into single spaces — it's spoken.
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length > MAX_THOUGHT_CHARS) {
    t = `${t.slice(0, MAX_THOUGHT_CHARS - 1).trimEnd()}…`;
  }
  return t;
}

/**
 * Generates one spontaneous BMO thought and captures it back into memory.
 *
 * Pipeline: recall seeds + profile → muse via {@link BRAIN_REASONING_MODEL} →
 * capture as a `'thought'` memory. Always resolves; returns null on any
 * failure (LLM error, empty output) so the caller simply skips this cycle.
 *
 * @param signal Optional abort signal threaded into recall, the LLM call, and
 *               capture (so a request timeout cancels the whole generation).
 */
export async function generateThought(signal?: AbortSignal): Promise<BmoThought | null> {
  // 1. RECALL — seed the thought with what BMO already knows. We query with a
  //    neutral self-reflective phrase so recall returns broadly relevant
  //    memories rather than nothing. Fully degradable: recall returns [] on
  //    any failure and we fall back to a cold-start seed.
  let memories: RecalledMemory[] = [];
  try {
    const recallOpts: { limit: number; minSimilarity: number; signal?: AbortSignal } = {
      limit: THOUGHT_RECALL_LIMIT,
      minSimilarity: THOUGHT_MIN_SIMILARITY,
    };
    if (signal !== undefined) recallOpts.signal = signal;
    memories = await recall('BMO dan teman kecilnya, hal-hal yang disukai dan dimainkan', recallOpts);
  } catch (err) {
    brainWarn('thoughts:recall', err);
  }

  // The durable child profile (gbrain "enrich the entity over time"). Best
  // effort: degrades to '' if the profile module/table is absent.
  let profileLine = '';
  try {
    const { profileSummary } = await import('@/lib/brain/profile');
    profileLine = await profileSummary();
  } catch (err) {
    brainWarn('thoughts:profile', err);
  }

  // 2. MUSE — one short in-character thought.
  let text: string;
  try {
    const req: Parameters<typeof chat>[0] = {
      model: BRAIN_REASONING_MODEL,
      systemPrompt: THOUGHT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserMessage(formatSeeds(memories), profileLine) }],
    };
    if (signal !== undefined) req.signal = signal;
    const res = await chat(req);
    text = cleanThought(res.text);
  } catch (err) {
    const msg = err instanceof OpenRouterError ? err.message : err instanceof Error ? err.message : String(err);
    brainWarn('thoughts:muse', msg);
    return null;
  }

  if (text.length === 0) {
    brainWarn('thoughts:muse', 'model returned an empty thought');
    return null;
  }

  // 3. CAPTURE — fold the thought back into memory so it compounds. Stored as
  //    kind 'thought'. Degradable: a failed capture still returns the thought
  //    so BMO can speak it; it just won't be recallable later.
  let memoryId: string | null = null;
  try {
    const captureOpts: Parameters<typeof capture>[1] = { kind: 'thought' };
    if (signal !== undefined) captureOpts.signal = signal;
    memoryId = await capture(`BMO memikirkan sendiri: "${text}"`, captureOpts);
  } catch (err) {
    brainWarn('thoughts:capture', err);
  }

  return { text, seededFrom: memories.length, memoryId };
}

/** Narrowing helper exported for tests / callers that inspect raw rows. */
export function isBmoThought(v: unknown): v is BmoThought {
  return isRecord(v) && typeof v.text === 'string';
}
