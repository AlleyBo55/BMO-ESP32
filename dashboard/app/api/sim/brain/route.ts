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
 * `/api/brain` — soul system prompt (the single source of truth for persona,
 * language, and style) + live time + brain-first memory recall + capture +
 * web search — but returns the reply as JSON text instead of streaming TTS
 * audio. This lets the simulator show the recalled memories and the reply text
 * alongside a per-stage status indicator.
 *
 * Request:  `{ text: string }`
 * Response: `{ reply, ms, model, memories: [...], memoryUsed, webCitations }`
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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
    return `\n\n[CURRENT TIME]\nRight now in Indonesia (WIB / Asia/Jakarta) it is: ${fmt.format(new Date())}. If asked the time/date/day, answer from THIS — never guess or invent a time.\n[/CURRENT TIME]`;
  })();
  // Soul is the single source of truth for persona/language/style (matches the
  // firmware /api/brain route). Only the live clock is appended.
  const systemPrompt = cfg.soul_md + timeBlock + memoryBlock;

  // Expose the `sing` tool to the simulator's LLM exactly as the firmware
  // route does, so the in-browser test decides to sing identically. (The
  // simulator doesn't wire play_song; song playback isn't exercised here.)
  const tools: OpenRouterTool[] = [];
  const singSkill = cfg.skills.sing;
  if (singSkill !== undefined && singSkill.enabled) {
    tools.push(buildSingTool());
  }

  try {
    const webSearchSkill = cfg.skills.web_search;
    const webSearchOn = webSearchSkill !== undefined && webSearchSkill.enabled;
    const reply = await chat({
      model: cfg.llm_model,
      systemPrompt,
      messages: [{ role: 'user', content: userText }],
      tools,
      webSearch: webSearchOn,
      signal: req.signal,
    });

    // Hard proof of whether the web plugin actually ran on this reply.
    const webCitations = reply.webCitations ?? 0;
    if (webSearchOn) {
      console.log(
        webCitations > 0
          ? `[sim/brain] web search USED — ${webCitations} citation(s) grounded the reply`
          : '[sim/brain] web search enabled but NOT used (model answered from training data)',
      );
    }

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
        webSearchEnabled: webSearchOn,
        webCitations,
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
