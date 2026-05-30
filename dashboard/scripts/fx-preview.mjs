/**
 * Generate a clean BMO line, then apply the robotic-radio effect, writing
 * both WAVs so you can A/B the effect. Uses the REAL lib/voice-fx via a tiny
 * inline reimplementation is avoided — we import the compiled logic by reading
 * raw PCM and piping it through applyRadioFx through a dynamic import.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const KEY = (env.match(/^OPENROUTER_API_KEY=(.+)$/m) || [])[1].trim();
const auth = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

const direction = [
  'You are voicing BMO, a small living video-game console from a kids cartoon.',
  'High-pitched, small, childlike, bright, playful, gender-neutral. A subtle cute robotic lilt.',
  'Speak the user text exactly as written in Indonesian. Do not read these instructions aloud.',
].join('\n');
const line = 'Hai! BMO di sini! Wah, senang sekali ketemu kamu! Mau main sama BMO, yuk? Hihi!';

function wavHeader(n, r = 24000, c = 1, b = 16) {
  const ba = c * (b / 8), br = r * ba, o = Buffer.alloc(44);
  o.write('RIFF', 0); o.writeUInt32LE(36 + n, 4); o.write('WAVE', 8);
  o.write('fmt ', 12); o.writeUInt32LE(16, 16); o.writeUInt16LE(1, 20);
  o.writeUInt16LE(c, 22); o.writeUInt32LE(r, 24); o.writeUInt32LE(br, 28);
  o.writeUInt16LE(ba, 32); o.writeUInt16LE(b, 34); o.write('data', 36); o.writeUInt32LE(n, 40);
  return o;
}

// ---- get clean PCM from OpenRouter ----
const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST', headers: { ...auth, Accept: 'text/event-stream' },
  body: JSON.stringify({
    model: 'openai/gpt-audio-mini', modalities: ['text', 'audio'],
    audio: { voice: 'fable', format: 'pcm16' }, stream: true,
    messages: [{ role: 'system', content: direction }, { role: 'user', content: line }],
  }),
});
if (!res.ok) { console.error('HTTP', res.status, (await res.text()).slice(0, 200)); process.exit(1); }
const reader = res.body.getReader(); const dec = new TextDecoder();
let buf = '', chunks = [];
while (true) {
  const { value, done } = await reader.read(); if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) !== -1) {
    const evt = buf.slice(0, i); buf = buf.slice(i + 2);
    for (const l of evt.split('\n')) {
      if (!l.startsWith('data:')) continue;
      const p = l.slice(5).trim(); if (p === '[DONE]') continue;
      try { const j = JSON.parse(p); const d = j?.choices?.[0]?.delta?.audio?.data; if (typeof d === 'string' && d) chunks.push(Buffer.from(d, 'base64')); } catch {}
    }
  }
}
const pcm = Buffer.concat(chunks);
writeFileSync(new URL('./e2e-out/clean.wav', import.meta.url), Buffer.concat([wavHeader(pcm.length), pcm]));

// ---- apply the real effect (compile TS on the fly via tsx is overkill; inline-equivalent) ----
// We import the effect through a dynamic import of a tiny shim that re-exports it.
const { RadioVoiceFx } = await import('./voicefx-shim.mjs');
const fx = new RadioVoiceFx();
const out = fx.process(pcm);
writeFileSync(new URL('./e2e-out/bmo-radio.wav', import.meta.url), Buffer.concat([wavHeader(out.length), out]));

console.log('wrote scripts/e2e-out/clean.wav and scripts/e2e-out/bmo-radio.wav');
console.log('clean PCM bytes:', pcm.length, ' processed:', out.length);
