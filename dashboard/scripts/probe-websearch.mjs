// One-off: probe OpenRouter web search directly with the real key.
//
// Tries three variants for the SAME question so we can see which (if any)
// actually grounds the answer with live web results:
//   A) plugins: [{ id: 'web', max_results: 3 }]   (what the app sends)
//   B) plugins: [{ id: 'web' }]                    (defaults)
//   C) model suffix ":online"                      (OpenRouter shorthand)
//
//   node scripts/probe-websearch.mjs
//
// Reads OPENROUTER_API_KEY (and optional model) from dashboard/.env.
import { readFileSync } from 'node:fs';

function loadEnv() {
  try {
    const raw = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    /* ambient env */
  }
}
loadEnv();

const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) {
  console.error('missing OPENROUTER_API_KEY');
  process.exit(1);
}
const MODEL = process.argv[2] ?? 'openai/gpt-4.1-mini';
const QUESTION = 'Siapa presiden Indonesia sekarang? Jawab singkat.';

async function call(label, body) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.log(`\n=== ${label} ===\nTRANSPORT ERROR: ${err}`);
    return;
  }
  const ms = Date.now() - t0;
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.log(`\n=== ${label} === (${res.status}, ${ms}ms)\nNON-JSON: ${text.slice(0, 400)}`);
    return;
  }
  const msg = json?.choices?.[0]?.message ?? {};
  const annotations = Array.isArray(msg.annotations) ? msg.annotations : [];
  const citeCount = annotations.filter((a) => a?.type === 'url_citation').length;
  console.log(`\n=== ${label} === (HTTP ${res.status}, ${ms}ms)`);
  if (json?.error) console.log('ERROR:', JSON.stringify(json.error));
  console.log('reply  :', (msg.content ?? '').slice(0, 200));
  console.log('cites  :', citeCount);
  if (citeCount > 0) {
    for (const a of annotations.filter((x) => x?.type === 'url_citation').slice(0, 3)) {
      console.log('   -', a.url_citation?.url ?? a.url ?? JSON.stringify(a).slice(0, 120));
    }
  }
  console.log('cost   :', json?.usage?.cost ?? json?.usage?.total_cost ?? 'n/a');
}

console.log(`model: ${MODEL}\nquestion: ${QUESTION}`);

await call('A plugins web max_results:3', {
  model: MODEL,
  messages: [{ role: 'user', content: QUESTION }],
  plugins: [{ id: 'web', max_results: 3 }],
});

await call('B plugins web (defaults)', {
  model: MODEL,
  messages: [{ role: 'user', content: QUESTION }],
  plugins: [{ id: 'web' }],
});

await call('C model :online suffix', {
  model: `${MODEL}:online`,
  messages: [{ role: 'user', content: QUESTION }],
});

await call('D no web (baseline)', {
  model: MODEL,
  messages: [{ role: 'user', content: QUESTION }],
});
