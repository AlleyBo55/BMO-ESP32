'use server';

import { randomBytes } from 'node:crypto';

import { hashPassword } from '@/lib/auth';
import { getServiceClient } from '@/lib/supabase-admin';

/**
 * Onboarding server action.
 *
 * Validates input, re-checks the admin count for defense-in-depth, hashes the
 * password and the fingerprint with argon2id, inserts the singleton admin row
 * with `ON CONFLICT (id) DO NOTHING`, upserts the singleton config row, and
 * returns the plaintext fingerprint so the page can reveal it exactly once.
 *
 * Returning the plaintext fingerprint is the only path the operator gets to
 * see it — it is hashed before persistence and the hash is one-way.
 */

export interface OnboardingInput {
  username: string;
  password: string;
  /** Empty string means "auto-generate a 32-byte fingerprint". */
  fingerprint: string;
}

export type OnboardingResult =
  | { ok: true; fingerprint: string }
  | {
      ok: false;
      error:
        | 'already_onboarded'
        | 'weak_password'
        | 'invalid_fingerprint'
        | 'username_required';
    };

/** Acceptable hex/base64 alphabet, 32+ chars. Decoded length verified separately. */
const FINGERPRINT_PATTERN = /^[A-Fa-f0-9+/=]{32,}$/;

/** Decodes a fingerprint string as either hex or base64; returns null on failure. */
function decodeFingerprint(value: string): Buffer | null {
  // Hex first: even length, only [0-9a-fA-F].
  if (/^[A-Fa-f0-9]+$/.test(value) && value.length % 2 === 0) {
    try {
      return Buffer.from(value, 'hex');
    } catch {
      // fallthrough to base64
    }
  }
  // Base64 (with optional padding).
  try {
    const decoded = Buffer.from(value, 'base64');
    // Buffer.from is permissive; round-trip to confirm.
    if (decoded.toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '')) {
      return decoded;
    }
  } catch {
    return null;
  }
  return null;
}

function isFingerprintValid(value: string): boolean {
  if (!FINGERPRINT_PATTERN.test(value)) return false;
  const decoded = decodeFingerprint(value);
  if (decoded === null) return false;
  return decoded.byteLength >= 32;
}

export async function createAdmin(
  input: OnboardingInput,
): Promise<OnboardingResult> {
  // ---- Validation ----------------------------------------------------------
  const username = input.username.trim();
  if (username.length === 0) {
    return { ok: false, error: 'username_required' };
  }
  if (input.password.length < 12) {
    return { ok: false, error: 'weak_password' };
  }
  let fingerprintPlain: string;
  if (input.fingerprint.length === 0) {
    fingerprintPlain = randomBytes(32).toString('hex');
  } else {
    if (!isFingerprintValid(input.fingerprint)) {
      return { ok: false, error: 'invalid_fingerprint' };
    }
    fingerprintPlain = input.fingerprint;
  }

  // ---- Defense-in-depth: re-check admin count -----------------------------
  const supabase = getServiceClient();
  const existing = await supabase
    .from('admin')
    .select('*', { count: 'exact', head: true });
  if (existing.error !== null) {
    throw new Error(`onboarding admin count failed: ${existing.error.message}`);
  }
  if ((existing.count ?? 0) >= 1) {
    return { ok: false, error: 'already_onboarded' };
  }

  // ---- Hashing -------------------------------------------------------------
  const passwordHash = await hashPassword(input.password);
  const fingerprintHash = await hashPassword(fingerprintPlain);

  // ---- Insert admin (race-safe) -------------------------------------------
  // PostgREST treats `upsert` with `ignoreDuplicates: true` as
  // `INSERT ... ON CONFLICT DO NOTHING`. We then verify a row was actually
  // written; if the count is zero we lost a race.
  const insertAdmin = await supabase
    .from('admin')
    .upsert(
      { id: 1, username, password_hash: passwordHash },
      { onConflict: 'id', ignoreDuplicates: true },
    )
    .select('id');
  if (insertAdmin.error !== null) {
    throw new Error(`onboarding admin insert failed: ${insertAdmin.error.message}`);
  }
  if (insertAdmin.data === null || insertAdmin.data.length === 0) {
    return { ok: false, error: 'already_onboarded' };
  }

  // ---- Upsert config row ---------------------------------------------------
  const upsertConfig = await supabase
    .from('config')
    .upsert(
      {
        id: 1,
        fingerprint_hash: fingerprintHash,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' },
    );
  if (upsertConfig.error !== null) {
    throw new Error(`onboarding config upsert failed: ${upsertConfig.error.message}`);
  }

  return { ok: true, fingerprint: fingerprintPlain };
}
