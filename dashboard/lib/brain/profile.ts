import 'server-only';

import { chat } from '@/lib/openrouter';
import { getServiceClient } from '@/lib/supabase-admin';
import { BRAIN_REASONING_MODEL, brainWarn } from '@/lib/brain/contracts';

/**
 * CHILD PROFILE — the durable, slowly-evolving portrait of BMO's kid.
 *
 * BMO is a companion toy for ONE child, and a toy feels like it truly knows
 * you when it remembers the stable things: your name, your age, the dinosaur
 * you love, the dark you're a little scared of, your best friend's name. This
 * module is gbrain's (https://github.com/garrytan/gbrain) "enrich the entity
 * over time" idea applied to that single primary user.
 *
 * Where `lib/brain.ts` captures the raw conversational stream and recalls it
 * by similarity, the profile is a tiny, hand-curatable set of key -> value
 * facts (mirrors public.brain_profile from 0006_brain_profile.sql). Each fact
 * carries a 0..1 confidence so a freshly-inferred guess can coexist with a
 * hard-stated truth. Facts are upserted by a normalized key so the profile
 * updates in place instead of accumulating duplicates.
 *
 * Graceful degradation (important): mirroring the rest of the brain core,
 * every function here resolves to a safe empty/no-op value and logs a warning
 * on failure. The profile is an ENHANCEMENT, never a hard dependency — if the
 * table is missing or an upstream call fails, BMO keeps talking exactly as it
 * did before. Nothing in this module throws.
 */

/** A single stored profile fact, mirrors a public.brain_profile row. */
export interface ProfileFact {
  key: string;
  value: string;
  confidence: number;
  updatedAt: string;
}

/** Neutral "reasonably sure" default for a newly-inferred fact. */
const DEFAULT_CONFIDENCE = 0.6;

/** Keep the deterministic summary comfortably short for prompt injection. */
const MAX_SUMMARY_CHARS = 400;

/** Cap how many facts a single exchange may yield, to bound LLM-driven writes. */
const MAX_FACTS_PER_EXCHANGE = 12;

/** Narrowing guard for plain objects (no `any`). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Clamps a confidence score into the table's 0..1 check constraint. */
function clampConfidence(confidence: number): number {
  if (!Number.isFinite(confidence)) return DEFAULT_CONFIDENCE;
  if (confidence < 0) return 0;
  if (confidence > 1) return 1;
  return confidence;
}

/**
 * Normalizes a fact key into the deduped match key the table stores: trimmed,
 * lowercased, internal whitespace folded to single underscores. Returns an
 * empty string when nothing usable remains so callers can skip the write.
 */
function normalizeKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

/* -------------------------------------------------------------------------- */
/* rememberFact — upsert one key -> value fact                                 */
/* -------------------------------------------------------------------------- */

/**
 * Records (or refreshes) a single fact about the child. Upserts on the
 * normalized `fact_key`: a repeat of the same key overwrites its value,
 * confidence, and updated_at rather than inserting a duplicate. Confidence is
 * clamped to 0..1. Always resolves; never throws — a failed write degrades to
 * a logged warning.
 */
export async function rememberFact(
  key: string,
  value: string,
  confidence: number = DEFAULT_CONFIDENCE,
): Promise<void> {
  const normalizedKey = normalizeKey(key);
  const trimmedValue = value.trim();
  if (normalizedKey.length === 0 || trimmedValue.length === 0) return;

  try {
    const supabase = getServiceClient();
    const { error } = await supabase
      .from('brain_profile')
      .upsert(
        {
          fact_key: normalizedKey,
          fact_value: trimmedValue,
          confidence: clampConfidence(confidence),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'fact_key' },
      );
    if (error !== null) {
      brainWarn('profile:remember', error.message);
    }
  } catch (err) {
    brainWarn('profile:remember', err);
  }
}

/* -------------------------------------------------------------------------- */
/* getProfile — read every fact, most confident first                          */
/* -------------------------------------------------------------------------- */

/**
 * Returns every stored fact about the child, highest confidence first. Always
 * resolves: on any failure (missing table, query error) it returns an empty
 * array and logs a warning so the caller can proceed profile-less.
 */
export async function getProfile(): Promise<ProfileFact[]> {
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from('brain_profile')
      .select('fact_key, fact_value, confidence, updated_at')
      .order('confidence', { ascending: false });
    if (error !== null) {
      brainWarn('profile:get', error.message);
      return [];
    }
    if (!Array.isArray(data)) return [];
    return data
      .map((row): ProfileFact | null => {
        if (!isRecord(row)) return null;
        if (typeof row.fact_key !== 'string' || typeof row.fact_value !== 'string') {
          return null;
        }
        return {
          key: row.fact_key,
          value: row.fact_value,
          confidence: typeof row.confidence === 'number' ? row.confidence : 0,
          updatedAt: typeof row.updated_at === 'string' ? row.updated_at : '',
        };
      })
      .filter((f): f is ProfileFact => f !== null);
  } catch (err) {
    brainWarn('profile:get', err);
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* profileSummary — a warm, deterministic Bahasa-Indonesia portrait           */
/* -------------------------------------------------------------------------- */

/**
 * Maps a normalized fact key to a natural English phrase describing the child.
 * This summary is injected into the system prompt as context for the model
 * (English, for reliable steering); recognized keys get a tailored lead-in
 * ("name is Budi", "is 6 years old"), and anything else falls back to a
 * readable "key: value" rendering so a profile built from arbitrary keys still
 * produces a sensible sentence. BMO's spoken reply remains Indonesian via the
 * language clamp applied at the route level.
 */
function phraseForFact(fact: ProfileFact): string {
  const value = fact.value.trim();
  if (value.length === 0) return '';
  switch (fact.key) {
    case 'name':
    case 'nama':
      return `their name is ${value}`;
    case 'age':
    case 'umur':
      return `they are ${value} years old`;
    case 'favorite':
    case 'favorite_thing':
    case 'suka':
    case 'kesukaan':
      return `they like ${value}`;
    case 'fear':
    case 'fears':
    case 'takut':
      return `they are afraid of ${value}`;
    case 'friend':
    case 'friends':
    case 'teman':
      return `their friend is ${value}`;
    default: {
      const readableKey = fact.key.replace(/_/g, ' ');
      return `${readableKey}: ${value}`;
    }
  }
}

/**
 * Builds a short English paragraph describing the child purely from the stored
 * facts — no LLM call, so it is fast, free, and deterministic. The paragraph
 * is context for the model (English for reliable steering), not spoken text.
 * Returns an empty string when there are no facts. Output is capped near
 * {@link MAX_SUMMARY_CHARS} so it stays cheap to inject into a system prompt.
 */
export async function profileSummary(): Promise<string> {
  const facts = await getProfile();
  if (facts.length === 0) return '';

  const phrases: string[] = [];
  for (const fact of facts) {
    const phrase = phraseForFact(fact);
    if (phrase.length === 0) continue;
    phrases.push(phrase);

    // Stop once we're about to overrun the budget rather than truncating
    // mid-phrase, so the paragraph always reads as complete sentences.
    const projected = `This child: ${phrases.join('; ')}.`;
    if (projected.length >= MAX_SUMMARY_CHARS) break;
  }
  if (phrases.length === 0) return '';

  const summary = `This child: ${phrases.join('; ')}.`;
  if (summary.length <= MAX_SUMMARY_CHARS) return summary;
  return `${summary.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd()}…`;
}

/* -------------------------------------------------------------------------- */
/* extractFactsFromExchange — mine durable facts from one turn                 */
/* -------------------------------------------------------------------------- */

const EXTRACTION_SYSTEM_PROMPT = [
  'You maintain the long-term PROFILE of a single young child who talks to a',
  'companion toy named BMO. From one exchange (the child + BMO reply), extract',
  'only STABLE, LONG-LIVED facts about the child: their name, age, favourite',
  'things, fears, friends, family, pets, and durable preferences.',
  '',
  'IGNORE ephemeral chatter — what they did today, passing moods, one-off',
  'questions, anything that will not still be true next month. If nothing',
  'durable is present, return an empty array.',
  '',
  'Reply with STRICT JSON only: an array of objects',
  '{ "key": string, "value": string, "confidence": number }.',
  'Use short snake_case English keys (e.g. "name", "age", "favorite_animal",',
  '"fear", "best_friend"). Keep values concise. confidence is 0..1: ~0.9 for',
  'something the child clearly stated, lower for an inference. No prose, no',
  'markdown fences — just the JSON array.',
].join('\n');

/**
 * Parses one extracted fact candidate into a `[key, value, confidence]` tuple,
 * or null when the shape is unusable. Tolerant on confidence (defaults when
 * absent/invalid) but strict on the key/value strings.
 */
function parseFactCandidate(candidate: unknown): [string, string, number] | null {
  if (!isRecord(candidate)) return null;
  if (typeof candidate.key !== 'string' || typeof candidate.value !== 'string') {
    return null;
  }
  const key = candidate.key.trim();
  const value = candidate.value.trim();
  if (key.length === 0 || value.length === 0) return null;
  const confidence =
    typeof candidate.confidence === 'number' ? candidate.confidence : DEFAULT_CONFIDENCE;
  return [key, value, confidence];
}

/**
 * Extracts the JSON array from an LLM reply that may wrap it in prose or
 * ```json fences. Returns the parsed array, or null when nothing array-shaped
 * can be recovered.
 */
function parseFactArray(text: string): unknown[] | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  // First try a direct parse; fall back to slicing the outermost [...] so a
  // chatty model that adds a sentence around the array still works.
  const attempts: string[] = [trimmed];
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start !== -1 && end > start) {
    attempts.push(trimmed.slice(start, end + 1));
  }

  for (const attempt of attempts) {
    try {
      const parsed: unknown = JSON.parse(attempt);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next candidate slice.
    }
  }
  return null;
}

/**
 * Uses the brain reasoning model to mine STABLE, long-lived facts about the
 * child from one conversational exchange and persists each via
 * {@link rememberFact}. Ephemeral chatter is ignored by the prompt.
 *
 * Returns the number of facts stored. Always resolves: on any failure (empty
 * input, LLM error, unparseable output) it returns 0 and logs a warning, so
 * this can be fired off the hot path without risk.
 */
export async function extractFactsFromExchange(
  userText: string,
  replyText: string,
  signal?: AbortSignal,
): Promise<number> {
  const child = userText.trim();
  const bmo = replyText.trim();
  if (child.length === 0 && bmo.length === 0) return 0;

  try {
    const res = await chat({
      model: BRAIN_REASONING_MODEL,
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Child said: "${child}"\nBMO replied: "${bmo}"`,
        },
      ],
      signal,
    });

    const candidates = parseFactArray(res.text);
    if (candidates === null) return 0;

    let stored = 0;
    for (const candidate of candidates) {
      if (stored >= MAX_FACTS_PER_EXCHANGE) break;
      const parsed = parseFactCandidate(candidate);
      if (parsed === null) continue;
      const [key, value, confidence] = parsed;
      await rememberFact(key, value, confidence);
      stored += 1;
    }
    return stored;
  } catch (err) {
    brainWarn('profile:extract', err);
    return 0;
  }
}
