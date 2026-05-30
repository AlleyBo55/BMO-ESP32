import 'server-only';

import { verify as argonVerify } from '@node-rs/argon2';

import { getConfig } from '@/lib/config';

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
 * The hash is loaded through `getConfig()` so fingerprint rotation uses the
 * same 5-second cache and post-write invalidation as the rest of the config.
 */

async function loadFingerprintHash(): Promise<string> {
  const cfg = await getConfig();
  return cfg.fingerprint_hash;
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

/** Test-only compatibility hook; config cache now owns freshness. */
export function _clearFingerprintCacheForTests(): void {
  // no-op
}
