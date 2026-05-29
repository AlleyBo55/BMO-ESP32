import 'server-only';

import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

import { getServiceClient } from '@/lib/supabase-admin';

/**
 * Node-only authentication helpers.
 *
 * - Argon2id is used for both admin password hashing and (elsewhere) the
 *   ESP32 fingerprint hash. Memory-hard parameters keep brute-force costs
 *   high even on a leaked Supabase dump.
 * - Login lockout is enforced via the `auth_attempts` table: 5 failed
 *   attempts inside a 15-minute rolling window locks the account until
 *   the window slides past the most recent failure.
 *
 * Session cookie + JWT helpers live in `lib/auth-session.ts` (Edge-safe).
 * They are re-exported here so existing call sites that do
 * `import { ... } from '@/lib/auth'` keep working unchanged.
 *
 * `import 'server-only'` keeps anything in this file out of the Edge
 * runtime and the client bundle. Middleware must NOT import from here.
 */

export {
  SESSION_COOKIE_NAME,
  issueSessionCookie,
  readSession,
  clearSessionCookie,
} from '@/lib/auth-session';

// ---------------------------------------------------------------------------
// Argon2id parameters
// ---------------------------------------------------------------------------

/** 64 MiB working set. */
const ARGON2_MEMORY_COST = 65_536;
/** 3 passes. */
const ARGON2_TIME_COST = 3;
/** 4 parallel lanes. */
const ARGON2_PARALLELISM = 4;
/**
 * Argon2id algorithm constant. The `@node-rs/argon2` package exports this
 * as a const enum which TypeScript blocks under `isolatedModules`, so we
 * pin the underlying numeric value here.
 */
const ARGON2_ALGORITHM_ID = 2;

/** Sliding lockout window length, in milliseconds. */
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

/** Failed-attempt threshold inside the lockout window. */
const LOCKOUT_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Hashes plaintext with argon2id (64 MiB / t=3 / p=4). */
export async function hashPassword(plain: string): Promise<string> {
  return argonHash(plain, {
    algorithm: ARGON2_ALGORITHM_ID,
    memoryCost: ARGON2_MEMORY_COST,
    timeCost: ARGON2_TIME_COST,
    parallelism: ARGON2_PARALLELISM,
  });
}

/** Constant-time verification of plaintext against an argon2id hash. */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (hash.length === 0) return false;
  try {
    return await argonVerify(hash, plain);
  } catch {
    // Malformed stored hash; treat as a mismatch rather than a crash.
    return false;
  }
}

/**
 * Returns true if the username has accumulated `LOCKOUT_THRESHOLD` failed
 * attempts within the rolling `LOCKOUT_WINDOW_MS` window.
 */
export async function isLockedOut(username: string): Promise<boolean> {
  const supabase = getServiceClient();
  const cutoff = new Date(Date.now() - LOCKOUT_WINDOW_MS).toISOString();
  const { count, error } = await supabase
    .from('auth_attempts')
    .select('*', { count: 'exact', head: true })
    .eq('username', username)
    .gte('attempted_at', cutoff);
  if (error !== null) {
    throw new Error(`isLockedOut query failed: ${error.message}`);
  }
  return count !== null && count >= LOCKOUT_THRESHOLD;
}

/** Inserts a single row recording a failed login attempt. */
export async function recordFailedAttempt(username: string): Promise<void> {
  const supabase = getServiceClient();
  const { error } = await supabase
    .from('auth_attempts')
    .insert({ username });
  if (error !== null) {
    throw new Error(`recordFailedAttempt insert failed: ${error.message}`);
  }
}

/** Clears every `auth_attempts` row for the named user. Called on success. */
export async function clearAttempts(username: string): Promise<void> {
  const supabase = getServiceClient();
  const { error } = await supabase
    .from('auth_attempts')
    .delete()
    .eq('username', username);
  if (error !== null) {
    throw new Error(`clearAttempts delete failed: ${error.message}`);
  }
}
