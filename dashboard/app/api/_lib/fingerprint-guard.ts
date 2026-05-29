import 'server-only';

import { verify as argonVerify } from '@node-rs/argon2';

import { getServiceClient } from '@/lib/supabase-admin';

/**
 * X-BMO-Fingerprint guard for firmware-facing API routes.
 *
 * The ESP32 sends its long random fingerprint in the `X-BMO-Fingerprint`
 * header on every request. The dashboard stores only the argon2id digest in
 * `config.fingerprint_hash`; we verify the supplied value against that
 * digest in constant time.
 *
 * NEVER log the supplied or stored fingerprint value. Only emit
 * `result.reason` ("missing" | "mismatch") or "ok".
 *
 * TODO(config): once `lib/config.ts` lands, replace the inline 5-second
 * cache below with `getConfig()` so cache-clear semantics are unified
 * across the codebase. Keeping the inline cache here lets task 12 ship
 * before task 9 without coupling them.
 */

/** How long a fetched fingerprint hash stays cached, in milliseconds. */
const CACHE_TTL_MS = 5_000;

interface FingerprintHashCache {
  hash: string;
  fetchedAt: number;
}

let cachedHash: FingerprintHashCache | null = null;

async function loadFingerprintHash(): Promise<string> {
  const now = Date.now();
  if (cachedHash !== null && now - cachedHash.fetchedAt < CACHE_TTL_MS) {
    return cachedHash.hash;
  }
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('config')
    .select('fingerprint_hash')
    .eq('id', 1)
    .maybeSingle();
  if (error !== null) {
    throw new Error(`fingerprint-guard config load failed: ${error.message}`);
  }
  const hash =
    data !== null && typeof data.fingerprint_hash === 'string'
      ? data.fingerprint_hash
      : '';
  cachedHash = { hash, fetchedAt: now };
  return hash;
}

export interface FingerprintGuardResult {
  ok: boolean;
  reason?: 'missing' | 'mismatch';
}

/**
 * Verifies the `X-BMO-Fingerprint` header on `req` against the stored hash.
 * Returns a structured result; never throws on auth failure. Throws only
 * on infrastructure errors (e.g. Supabase unreachable).
 */
export async function verifyFingerprint(
  req: Request,
): Promise<FingerprintGuardResult> {
  const supplied = req.headers.get('x-bmo-fingerprint');
  if (supplied === null || supplied.length === 0) {
    return { ok: false, reason: 'missing' };
  }

  const storedHash = await loadFingerprintHash();
  if (storedHash.length === 0) {
    // No fingerprint configured yet (pre-onboarding) — treat as a mismatch
    // rather than a misleading "missing".
    return { ok: false, reason: 'mismatch' };
  }

  let matched = false;
  try {
    matched = await argonVerify(storedHash, supplied);
  } catch {
    matched = false;
  }
  if (!matched) {
    return { ok: false, reason: 'mismatch' };
  }
  return { ok: true };
}

/** Test-only: clear the in-module cache so rotation tests can re-read. */
export function _clearFingerprintCacheForTests(): void {
  cachedHash = null;
}
