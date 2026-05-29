#!/usr/bin/env node
// =============================================================================
// check-bundle-secrets.mjs
//
// Post-build guard: greps the Next.js client bundle (.next/static/**/*.js) for
// any string that looks like a server-only env var name or a real secret value.
// Catches the failure mode where someone accidentally inlines a server secret
// into a client component — e.g. by importing `serverEnv` from a `'use client'`
// file or by stringifying the wrong config object.
//
// Property 11 (No client bundle leaks): the Next.js production build emits zero
// references to SUPABASE_SECRET_KEY, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY,
// or AUTH_SESSION_SECRET in any chunk under .next/static/.
//
// Exits 1 on any match (printing every match), exits 0 on a clean bundle.
// =============================================================================

import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const BUNDLE_ROOT = resolve(__dirname, '..', '.next', 'static');

// Server-only env var names. If any of these literal strings appears in a
// client chunk it means a server module leaked into the browser bundle.
const FORBIDDEN_ENV_NAMES = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SECRET_KEY',
  'OPENROUTER_API_KEY',
  'AUTH_SESSION_SECRET',
];

// Secret-shape regexes. Catches real-looking key values that should never
// appear in a client bundle regardless of variable name.
const FORBIDDEN_PATTERNS = [
  { name: 'anthropic-key',     re: /sk-ant-[a-z0-9_-]{10,}/i },
  { name: 'openrouter-key',    re: /sk-or-[a-z0-9_-]{10,}/i },
  { name: 'supabase-anon-jwt', re: /aoaAA[A-Za-z0-9_-]{10,}/ },
  { name: 'supabase-srv-jwt',  re: /aorAA[A-Za-z0-9_-]{10,}/ },
  // New-format Supabase keys (post-2024 rename).
  { name: 'supabase-secret',   re: /sb_secret_[A-Za-z0-9_-]{10,}/ },
  { name: 'aws-access-key',    re: /AKIA[0-9A-Z]{16}/ },
  { name: 'aws-temp-key',      re: /ASIA[0-9A-Z]{16}/ },
  { name: 'github-pat',        re: /ghp_[A-Za-z0-9]{20,}/ },
];

/**
 * Returns the line containing `index` in `text`, with its 1-based line number.
 */
function lineAt(text, index) {
  const before = text.slice(0, index);
  const lineNumber = before.split('\n').length;
  const lineStart = before.lastIndexOf('\n') + 1;
  const lineEnd = text.indexOf('\n', index);
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
  // Truncate noisy minified lines so the report is readable.
  const trimmed = line.length > 240
    ? `${line.slice(0, 120)} … ${line.slice(-100)}`
    : line;
  return { lineNumber, line: trimmed };
}

async function collectFiles() {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      throw err;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        out.push(full);
      }
    }
    return out;
  }
  const found = await walk(BUNDLE_ROOT);
  if (found === null) {
    console.error(`[check-bundle-secrets] no bundle found at ${BUNDLE_ROOT}`);
    console.error('[check-bundle-secrets] run `pnpm build` before this script.');
    process.exit(2);
  }
  return out;
}

async function main() {
  const files = await collectFiles();
  if (files.length === 0) {
    console.error(`[check-bundle-secrets] no .js files under ${BUNDLE_ROOT}`);
    console.error('[check-bundle-secrets] run `pnpm build` before this script.');
    process.exit(2);
  }

  /** @type {Array<{file: string, hit: string, lineNumber: number, line: string}>} */
  const violations = [];

  for (const file of files) {
    const content = await readFile(file, 'utf8');

    for (const name of FORBIDDEN_ENV_NAMES) {
      let idx = content.indexOf(name);
      while (idx !== -1) {
        const { lineNumber, line } = lineAt(content, idx);
        violations.push({ file, hit: `env-name:${name}`, lineNumber, line });
        idx = content.indexOf(name, idx + name.length);
      }
    }

    for (const { name, re } of FORBIDDEN_PATTERNS) {
      const flagged = re.flags.includes('g') ? re : new RegExp(re.source, `${re.flags}g`);
      for (const match of content.matchAll(flagged)) {
        if (match.index === undefined) continue;
        const { lineNumber, line } = lineAt(content, match.index);
        violations.push({ file, hit: `pattern:${name}`, lineNumber, line });
      }
    }
  }

  if (violations.length > 0) {
    console.error('\n✖ secret leak detected in client bundle:\n');
    for (const v of violations) {
      const rel = v.file.replace(`${process.cwd()}/`, '');
      console.error(`  ${rel}:${v.lineNumber}  [${v.hit}]`);
      console.error(`    ${v.line}`);
    }
    console.error(
      `\n${violations.length} match(es) across ${files.length} file(s). ` +
      `bundle MUST NOT contain server secrets — fix the import, then rebuild.\n`,
    );
    process.exit(1);
  }

  console.log(`✓ checked ${files.length} bundle file(s), no secrets leaked.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[check-bundle-secrets] unexpected error:', err);
  process.exit(2);
});
