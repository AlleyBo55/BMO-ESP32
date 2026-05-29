#!/usr/bin/env node
// =============================================================================
// check-supabase.mjs
//
// Connects to the configured Supabase project using the same env vars the
// dashboard reads at runtime, then runs the same admin-count query that the
// middleware runs on every request. Prints a clear diagnostic for the most
// common failure modes:
//
//   * NEXT_PUBLIC_SUPABASE_URL missing or pointing at the wrong project
//   * SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY) missing or
//     belonging to a different project
//   * schema.sql has not been applied (table "admin" does not exist)
//
// Usage:  node scripts/check-supabase.mjs
// =============================================================================

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');

// Manual .env parse so this script doesn't depend on Next's loader.
function loadDotEnv(path) {
  try {
    const text = readFileSync(path, 'utf8');
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line === '' || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined || process.env[key] === '') {
        process.env[key] = value;
      }
    }
  } catch {
    /* file optional */
  }
}

loadDotEnv(resolve(ROOT, '.env.local'));
loadDotEnv(resolve(ROOT, '.env'));

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret =
  process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !secret) {
  console.error('✖ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY.');
  console.error('  Check dashboard/.env or .env.local.');
  process.exit(1);
}

console.log(`→ URL:    ${url}`);
console.log(
  `→ Secret: ${secret.slice(0, 8)}…${secret.slice(-4)} (${secret.length} chars)`,
);

const { createClient } = await import('@supabase/supabase-js');
const supabase = createClient(url, secret, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

const { count, error } = await supabase
  .from('admin')
  .select('*', { count: 'exact', head: true });

if (error !== null) {
  console.error('✖ admin-count query failed.');
  console.error(`  message: ${error.message || '(empty)'}`);
  if (error.code !== undefined) console.error(`  code:    ${error.code}`);
  if (error.details) console.error(`  details: ${error.details}`);
  if (error.hint) console.error(`  hint:    ${error.hint}`);
  console.error('');
  if (
    /relation .* does not exist/i.test(error.message) ||
    error.code === '42P01'
  ) {
    console.error('  Likely cause: schema.sql has NOT been applied yet.');
    console.error('  Fix: Supabase dashboard → SQL editor → paste contents of');
    console.error('       supabase/schema.sql and run it. Then run this again.');
  } else if (
    /Invalid API key/i.test(error.message) ||
    /JWS|JWT/i.test(error.message)
  ) {
    console.error('  Likely cause: SUPABASE_SECRET_KEY is wrong or belongs to');
    console.error('  a different project. Copy the "Secret key" from');
    console.error('  Supabase → Settings → API Keys.');
  }
  process.exit(2);
}

console.log(`✓ admin table reachable. row count = ${count ?? 0}`);
console.log(
  count === 0
    ? '  (zero admins — middleware will redirect everything to /onboarding)'
    : '  (admin exists — middleware will gate everything behind /login)',
);
