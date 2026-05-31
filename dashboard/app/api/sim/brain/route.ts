import 'server-only';

import { after } from 'next/server';

import { requireAdmin } from '@/lib/api-auth';
import { captureExchange, formatRecallForPrompt, recall, type RecalledMemory } from '@/lib/brain';
import { getConfig } from '@/lib/config';
import { chat, OpenRouterError, type OpenRouterTool } from '@/lib/openrouter';
import { buildSingTool, extractSingLyrics } from '@/lib/voice';

/**
 * POST /api/sim/brain — simulator LLM (brain) stage.
 *
 * Browser-facing. Runs the EXACT same cognition the firmware path runs in
 * `/api/brain` — soul system prompt + language clamp + brain-first memory
 * recall + capture — but returns the reply as JSON text instead of streaming
 * TTS audio. This lets the simulator show the recalled memories and the
 * reply text alongside a per-stage status indicator.
 *
 * Request:  `{ text: string }`
 * Response: `{ reply, ms, model, memories: [{ content, similarity }], memoryUsed }`
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Kept in sync with the firmware route's clamp. Duplicated rather than
 * exported to avoid coupling the simulator to the streaming route's module
 * (which pulls in audio-transcode + ffmpeg). If the firmware clamp changes,
 * mirror it here so the simulator reflects production behavior.
 */
const LANGUAGE_DIRECTIVE = `\n\n[LANGUAGE]
Always reply in Bahasa Indonesia (Indonesian), regardless of the language the user spoke. Use natural, warm, kid-friendly Indonesian. Avoid English loanwords unless a single specific term has no good Indonesian equivalent. Keep names of people, places, and brands as-is unless the Indonesian form is more familiar. Never narrate this rule, never apologize for it, never switch languages.
[/LANGUAGE]

[STYLE]
Keep replies SHORT and direct — 1 to 2 short sentences for a normal question, like a quick chat between friends, not a paragraph. Answer the actual question FIRST and plainly, then you may add one short playful touch. Do not pile on adjectives, do not list many options, do not ramble. If the child asks a follow-up that depends on the previous turn, treat the recent conversation as the context and stay on that topic — do not change the subject on your own.
Do NOT insert your own name "BMO" into the middle of factual sentences (e.g. never say "warna semangka BMO itu..."). Just answer plainly. Refer to yourself sparingly and naturally, not in every sentence.
Do NOT end every reply with a question. Only ask a follow-up when it is genuinely natural — most replies should just answer and stop.
[/STYLE]

[NAME PRONUNCIATION]
Write your own name as "BMO" in text. Use it sparingly.
[/NAME]

[CHILD]
You are a companion to ONE child. Learn who they are from the conversation; never invent details.
- If a [CHILD PROFILE] block below tells you the child's name, you ALREADY KNOW IT. Use it only occasionally and naturally — do NOT tack the name onto the end of every reply, and NEVER ask for a name you already know.
- If you do NOT yet know the child's name, you may gently ask for it ONCE, then use it. Don't ask again after that.
- Whenever the child tells you their name (or corrects it), accept the newest one as the truth from then on.
- Speech-to-text can garble names. If a stated name sounds garbled or uncertain, gently confirm it once instead of guessing a different name.
[/CHILD]`;

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

export async function POST(req: Request): Promise<Response> {
  const startedAt = Date.now();

  if (!(await requireAdmin(req))) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return jsonResponse({ stage: 'llm', error: 'invalid_json' }, 400);
  }
  if (!isRecord(parsed) || typeof parsed.text !== 'string' || parsed.text.trim().length === 0) {
    return jsonResponse({ stage: 'llm', error: 'invalid_body' }, 400);
  }
  const userText = parsed.text;

  const cfg = await getConfig();

  // Brain-first recall, gated on the memory skill — identical to the
  // firmware path so the simulator faithfully exercises the brain.
  let memories: RecalledMemory[] = [];
  const memorySkill = cfg.skills.memory;
  const memoryEnabled = memorySkill !== undefined && memorySkill.enabled;
  if (memoryEnabled) {
    memories = await recall(userText, { signal: req.signal });
  }
  const memoryBlock = formatRecallForPrompt(memories);
  const timeBlock = (() => {
    const fmt = new Intl.DateTimeFormat('id-ID', {
      timeZone: 'Asia/Jakarta',
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    return `\n\n[CURRENT TIME]\nRight now in Indonesia (WIB) it is: ${fmt.format(new Date())}. If asked the time/date/day, answer from THIS — never guess. Pick pagi/siang/sore/malam from the 24-hour value.\n[/CURRENT TIME]`;
  })();
  const systemPrompt = cfg.soul_md + LANGUAGE_DIRECTIVE + timeBlock + memoryBlock;

  // Expose the `sing` tool to the simulator's LLM exactly as the firmware
  // route does, so the in-browser test decides to sing identically. (The
  // simulator doesn't wire play_song; song playback isn't exercised here.)
  const tools: OpenRouterTool[] = [];
  const singSkill = cfg.skills.sing;
  if (singSkill !== undefined && singSkill.enabled) {
    tools.push(buildSingTool());
  }

  try {
    const reply = await chat({
      model: cfg.llm_model,
      systemPrompt,
      messages: [{ role: 'user', content: userText }],
      tools,
      signal: req.signal,
    });

    // Did BMO choose to sing? Surface the lyrics so the simulator can voice
    // them with the singing direction via /api/sim/tts.
    const singLyrics = extractSingLyrics(reply.toolCalls);

    // Auto-grow the brain after responding (off the hot path).
    if (memoryEnabled) {
      const refor = singLyrics !== null ? `🎵 ${singLyrics}` : reply.text;
      after(async () => {
        await captureExchange(userText, refor);
      });
    }

    return jsonResponse(
      {
        reply: reply.text,
        sing: singLyrics,
        ms: Date.now() - startedAt,
        model: cfg.llm_model,
        memoryUsed: memoryEnabled,
        memories: memories.map((m) => ({
          content: m.content,
          similarity: Math.round(m.similarity * 1000) / 1000,
          createdAt: m.createdAt,
        })),
        inputTokens: reply.inputTokens ?? null,
        outputTokens: reply.outputTokens ?? null,
        costUsd: reply.costUsd ?? null,
        // Full debug surface: exactly what the LLM saw and produced.
        debug: {
          systemPrompt,
          memoryBlock,
          userMessage: userText,
          soulChars: cfg.soul_md.length,
          memoryBlockChars: memoryBlock.length,
          toolCalls: reply.toolCalls,
        },
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
    return jsonResponse({ stage: 'llm', error: message, ms: Date.now() - startedAt }, 502);
  }
}
