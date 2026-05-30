import 'server-only';

import { after } from 'next/server';

import { requireAdmin } from '@/lib/api-auth';
import { captureExchange, formatRecallForPrompt, recall, type RecalledMemory } from '@/lib/brain';
import { getConfig } from '@/lib/config';
import { chat, OpenRouterError } from '@/lib/openrouter';

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
[/LANGUAGE]`;

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
  const systemPrompt = cfg.soul_md + LANGUAGE_DIRECTIVE + memoryBlock;

  try {
    const reply = await chat({
      model: cfg.llm_model,
      systemPrompt,
      messages: [{ role: 'user', content: userText }],
      signal: req.signal,
    });

    // Auto-grow the brain after responding (off the hot path).
    if (memoryEnabled) {
      const refor = reply.text;
      after(async () => {
        await captureExchange(userText, refor);
      });
    }

    return jsonResponse(
      {
        reply: reply.text,
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
