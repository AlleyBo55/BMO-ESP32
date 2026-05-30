/**
 * Real end-to-end smoke test against the live OpenRouter API.
 *
 * Mirrors the exact request shapes the BMO pipeline uses (lib/openrouter.ts):
 *   1. LLM        — chat completion with BMO's soul as system prompt.
 *   2. TTS        — stream PCM16 audio of the reply, wrap as a real WAV.
 *   3. STT        — feed that WAV back, transcribe it (closes the loop).
 *   4. Embeddings — embed a phrase (the brain recall/capture path).
 *
 * Spends real OpenRouter credit. Writes artifacts to scripts/e2e-out/.
 * Prints a per-stage PASS/FAIL table with latency at the end.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Buffer } from 'node:buffer';

const BASE = 'https://openrouter.ai/api/v1';
const OUT = new URL('./e2e-out/', import.meta.url);

// ---- read the key from .env without importing the app -----------------------
const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const KEY = (env.match(/^OPENROUTER_API_KEY=(.+)$/m) || [])[1]?.trim();
if (!KEY) {
  console.error('No OPENROUTER_API_KEY in .env');
  process.exit(1);
}

// ---- models (match lib/config.ts defaults) ----------------------------------
const LLM_MODEL = 'openai/gpt-4.1-mini';
const TTS_MODEL = 'openai/gpt-audio-mini';
const TTS_VOICE = 'nova';
const STT_MODEL = 'qwen/qwen3-asr-flash-2026-02-10';
const EMBED_MODEL = 'openai/text-embedding-3-small';

const SOUL = 'Kamu adalah BMO, mainan kecil yang ramah. Jawab singkat dan hangat dalam Bahasa Indonesia.';
const USER_TEXT = 'Halo BMO! Nama aku Gilang dan aku suka dinosaurus. Apa kabar?';

const auth = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const results = [];
function record(stage, ok, ms, detail) {
  results.push({ stage, ok, ms, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${stage} (${ms}ms) — ${detail}`);
}

function wavHeader(pcmLen, rate = 24000, ch = 1, bits = 16) {
  const blockAlign = ch * (bits / 8);
  const byteRate = rate * blockAlign;
  const b = Buffer.alloc(44);
  b.write('RIFF', 0); b.writeUInt32LE(36 + pcmLen, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(ch, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(byteRate, 28);
  b.writeUInt16LE(blockAlign, 32); b.writeUInt16LE(bits, 34);
  b.write('data', 36); b.writeUInt32LE(pcmLen, 40);
  return b;
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  // ---- 1. LLM --------------------------------------------------------------
  let reply = '';
  {
    const t0 = Date.now();
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({
          model: LLM_MODEL,
          messages: [
            { role: 'system', content: SOUL },
            { role: 'user', content: USER_TEXT },
          ],
        }),
      });
      const json = await res.json();
      reply = json?.choices?.[0]?.message?.content ?? '';
      if (!res.ok || !reply) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
      writeFileSync(new URL('reply.txt', OUT), reply);
      record('LLM', true, Date.now() - t0, `reply: "${reply.slice(0, 90)}"`);
    } catch (e) {
      record('LLM', false, Date.now() - t0, e.message);
    }
  }

  // ---- 2. TTS (stream PCM16 → WAV) -----------------------------------------
  let wavPath = null;
  if (reply) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST', headers: { ...auth, Accept: 'text/event-stream' },
        body: JSON.stringify({
          model: TTS_MODEL, modalities: ['text', 'audio'],
          audio: { voice: TTS_VOICE, format: 'pcm16' }, stream: true,
          messages: [{ role: 'user', content: reply }],
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', pcmChunks = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const evt = buf.slice(0, i); buf = buf.slice(i + 2);
          for (const line of evt.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const j = JSON.parse(payload);
              const d = j?.choices?.[0]?.delta?.audio?.data;
              if (typeof d === 'string' && d) pcmChunks.push(Buffer.from(d, 'base64'));
            } catch {}
          }
        }
      }
      const pcm = Buffer.concat(pcmChunks);
      if (pcm.length === 0) throw new Error('no audio bytes produced');
      const wav = Buffer.concat([wavHeader(pcm.length), pcm]);
      wavPath = new URL('bmo-reply.wav', OUT);
      writeFileSync(wavPath, wav);
      record('TTS', true, Date.now() - t0, `${(wav.length / 1024).toFixed(0)} KB WAV (${pcm.length} PCM bytes)`);
    } catch (e) {
      record('TTS', false, Date.now() - t0, e.message);
    }
  }

  // ---- 3. STT (feed the WAV back) ------------------------------------------
  if (wavPath) {
    const t0 = Date.now();
    try {
      const wav = readFileSync(wavPath);
      const res = await fetch(`${BASE}/audio/transcriptions`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({
          model: STT_MODEL,
          input_audio: { data: wav.toString('base64'), format: 'wav' },
        }),
      });
      const json = await res.json();
      const text = json?.text ?? '';
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
      writeFileSync(new URL('transcript.txt', OUT), text);
      record('STT', !!text, Date.now() - t0, text ? `heard: "${text.slice(0, 90)}"` : 'empty transcript');
    } catch (e) {
      record('STT', false, Date.now() - t0, e.message);
    }
  }

  // ---- 4. Embeddings (brain recall/capture path) ---------------------------
  {
    const t0 = Date.now();
    try {
      const res = await fetch(`${BASE}/embeddings`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({ model: EMBED_MODEL, input: USER_TEXT, dimensions: 1536 }),
      });
      const json = await res.json();
      const vec = json?.data?.[0]?.embedding;
      if (!res.ok || !Array.isArray(vec)) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
      record('Embeddings', vec.length === 1536, Date.now() - t0, `${vec.length}-dim vector`);
    } catch (e) {
      record('Embeddings', false, Date.now() - t0, e.message);
    }
  }

  // ---- summary -------------------------------------------------------------
  console.log('\n=== END-TO-END RESULT ===');
  const pass = results.filter(r => r.ok).length;
  for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.stage.padEnd(11)} ${String(r.ms).padStart(6)}ms`);
  console.log(`  ${pass}/${results.length} stages passed`);
  console.log(`  artifacts: scripts/e2e-out/ (reply.txt, bmo-reply.wav, transcript.txt)`);
  process.exit(pass === results.length ? 0 : 1);
}

main();
