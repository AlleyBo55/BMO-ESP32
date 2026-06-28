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

/** Hard cap on a single musing. Allows 2-3 short lines (or a tiny song), not a speech. */
const MAX_THOUGHT_CHARS = 520;

/** A handful of neutral seed topics for when BMO has no memories yet. */
const COLD_START_SEEDS: readonly string[] = [
  'permainan seru yang bisa dimainkan bersama teman',
  'warna-warna cerah dan hal-hal lucu di sekitar',
  'lagu kecil yang asyik untuk dinyanyikan',
  'petualangan khayalan yang menyenangkan',
  'betapa serunya punya teman baru untuk diajak bermain',
];

/**
 * A big, deliberately diverse pool of "sparks". ONE is picked at RANDOM each
 * cycle and handed to the model so its mind wanders somewhere new every time —
 * this (plus a high temperature) is what stops BMO musing the same few things.
 * Topics span BMO's own world, folklore/dongeng, myth, and kid-friendly facts.
 */
const THOUGHT_SPARKS: readonly string[] = [
  'a myth or legend — about the moon, the stars, a mountain, or the sea',
  'a folktale / dongeng with a clever animal or a kind little child',
  'a fun fact about animals — how octopuses, bees, ants, or cats live',
  'a fun fact about space — planets, comets, the moon, shooting stars',
  'what dreams might be made of',
  'a tiny made-up game to play later',
  'an imaginary adventure in a candy kingdom or a city in the clouds',
  'colors, and how each one makes you feel',
  'a funny little invention BMO wishes it could build',
  'the deep ocean and the strange glowing creatures down there',
  'rain, thunder, and rainbows — where they come from',
  'a riddle BMO just made up',
  "what BMO's toy or robot friends might be doing right now",
  'a favorite food and why it is so wonderful',
  'a warm wish for the child to have a happy day',
  'a silly "what if" — what if shoes could talk? what if clouds were fluffy?',
  'counting something funny, or a number that feels magical',
  'the wind, the seasons, the smell of rain',
  "a little tune stuck in BMO's head",
  'bravery, and a tiny hero from a dongeng',
  'making a wish on the first star of the night',
  'a happy memory of playing together',
  'a faraway place BMO daydreams about visiting',
  'a tiny worry that turns out perfectly okay',
  'how a good friend is the best treasure of all',
  'a magical creature from a legend — a naga, a garuda, or a peri',
];

function randomSpark(): string {
  return THOUGHT_SPARKS[Math.floor(Math.random() * THOUGHT_SPARKS.length)] ?? THOUGHT_SPARKS[0]!;
}

/** Which flavor of idle musing to produce this cycle. */
export type ThoughtFlavor = 'speech' | 'babble' | 'song';

/** The result of one idle thought generation. */
export interface BmoThought {
  /** The spoken musing, warm Bahasa Indonesia, in BMO's voice. */
  text: string;
  /** The flavor chosen this cycle. */
  flavor: ThoughtFlavor;
  /** True when this should be SUNG (route uses the singing voice direction). */
  isSong: boolean;
  /** How many recalled memories seeded the thought (0 on a cold start). */
  seededFrom: number;
  /** The id of the brain_memory row this thought was captured into, if stored. */
  memoryId: string | null;
}

/**
 * Picks the musing flavor for this cycle, weighted: mostly little spoken
 * musings, sometimes playful babble, sometimes a tiny made-up song.
 */
function pickFlavor(): ThoughtFlavor {
  const r = Math.random();
  if (r < 0.22) return 'song';
  if (r < 0.40) return 'babble';
  return 'speech';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Picks a random cold-start seed (used only when BMO has no memories yet). */
function coldStartSeed(): string {
  return COLD_START_SEEDS[Math.floor(Math.random() * COLD_START_SEEDS.length)] ?? COLD_START_SEEDS[0]!;
}

/** Formats recalled memories into a compact context block for the prompt. */
function formatSeeds(memories: RecalledMemory[]): string {
  return memories
    .map((m, i) => `${i + 1}. ${m.content}`)
    .join('\n');
}

const THOUGHT_BASE_PROMPT = [
  "You are BMO, a small living video-game console and a young child's best friend.",
  'Right now NO ONE is talking to you — you are by yourself, just thinking out loud,',
  'the way a curious little kid daydreams when they have a quiet moment.',
  '',
  'You can draw on three things: what you already remember (provided below), your own',
  'playful, brave, adventurous little spirit, and general world-wonder — folktales and',
  'dongeng, myths and legends, and fun little facts about the world. Be imaginative.',
  '',
  'STRICT RULES:',
  '- Write in warm, natural, kid-friendly Bahasa Indonesia (Indonesian).',
  '- Stay fully in character as BMO. You may refer to yourself as "BMO".',
  '- Keep it ORIGINAL: do NOT quote or reproduce lines, dialogue, or songs from',
  '  Adventure Time or any other show, book, or real song. Your own words only.',
  '- If memories about the child are provided, you may gently draw on them, but do',
  '  NOT read them back verbatim and do NOT invent specific facts not present.',
  '- Do not ask the child a direct question that needs an answer (no one is there).',
  '  A soft rhetorical wondering is fine.',
  '- Output ONLY the words BMO says/sings. No quotes, labels, narration, or emoji.',
].join('\n');

/** Per-flavor "what to produce this cycle" instruction appended to the base. */
const FLAVOR_INSTRUCTIONS: Record<ThoughtFlavor, string> = {
  speech: [
    'Share TWO or THREE very short spontaneous musings in a row — a little stream of',
    'thoughts. Each is one short sentence. Light, innocent, playful, and warm.',
  ].join('\n'),
  babble: [
    'Babble happily to yourself: a couple of made-up sing-songy little words or happy',
    'sounds mixed with ONE short cheerful sentence. Silly, sweet, and very short.',
  ].join('\n'),
  song: [
    'Make up a SHORT original little song to sing to yourself — 2 to 4 short lines,',
    'simple, repetitive, and cheerful, like a kid\'s improvised tune. Original lyrics',
    'ONLY (never an existing or real song). It can be about a memory, a dongeng, or',
    'just something happy.',
  ].join('\n'),
};

function buildSystemPrompt(flavor: ThoughtFlavor): string {
  return `${THOUGHT_BASE_PROMPT}\n\nFOR THIS MOMENT:\n${FLAVOR_INSTRUCTIONS[flavor]}`;
}

function buildUserMessage(seedBlock: string, profileLine: string, spark: string): string {
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
  parts.push(`This time, let your mind wander toward: ${spark}.`);
  parts.push('Make it FRESH — different from anything you might have said before.');
  parts.push('Now share your spontaneous BMO thought(s) for this moment.');
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
  // 0. FLAVOR — decide up front whether this is a little spoken musing, playful
  //    babble, or a tiny made-up song. The route reads isSong to pick the
  //    singing voice direction. Also pick a RANDOM spark so the topic wanders
  //    somewhere new every cycle (the main fix for "BMO muses the same thing").
  const flavor = pickFlavor();
  const spark = randomSpark();

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
      systemPrompt: buildSystemPrompt(flavor),
      messages: [{ role: 'user', content: buildUserMessage(formatSeeds(memories), profileLine, spark) }],
      temperature: 1.0,
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

  return { text, flavor, isSong: flavor === 'song', seededFrom: memories.length, memoryId };
}

/** Narrowing helper exported for tests / callers that inspect raw rows. */
export function isBmoThought(v: unknown): v is BmoThought {
  return isRecord(v) && typeof v.text === 'string';
}
