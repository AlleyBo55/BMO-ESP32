// One-off: set the persisted BMO config volume (0..100).
//
// Brain replies, idle thoughts, TTS and songs all carry `X-BMO-Volume` read
// from the singleton config row in Supabase — that value OVERRIDES the
// firmware default for those paths. Bumping the in-code default only affects
// a fresh database, so this script patches the live row directly.
//
//   node scripts/set-volume.mjs 90
//
// Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY (or the legacy
// SUPABASE_SERVICE_ROLE_KEY) from dashboard/.env.
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

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
    /* fall back to ambient env */
  }
}

loadEnv();

const volume = Number.parseInt(process.argv[2] ?? '', 10);
if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
  console.error('usage: node scripts/set-volume.mjs <0..100>');
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key =
  process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY');
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data, error } = await supabase
  .from('config')
  .update({ volume })
  .eq('id', 1)
  .select('volume')
  .single();

if (error) {
  console.error('update failed:', error.message);
  process.exit(1);
}
console.log(`config.volume set to ${data.volume}`);
