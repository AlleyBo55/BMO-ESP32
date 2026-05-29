'use server';

import { randomBytes } from 'node:crypto';

import { hashPassword } from '@/lib/auth';
import { updateConfig } from '@/lib/config';

export type RotateFingerprintResult =
  | { ok: true; fingerprint: string }
  | { ok: false; error: string };

/**
 * Rotates the BMO fingerprint.
 *
 * Generates 32 random bytes (64 hex chars), hashes the plaintext with
 * argon2id, persists the hash, and returns the plaintext exactly once so the
 * admin can copy it into the firmware's `secrets.h`. The plaintext is never
 * persisted server-side; if the admin loses it they must rotate again.
 */
export async function rotateFingerprint(): Promise<RotateFingerprintResult> {
  try {
    const fingerprint = randomBytes(32).toString('hex');
    const hash = await hashPassword(fingerprint);

    await updateConfig({ fingerprint_hash: hash });

    return { ok: true, fingerprint };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'rotation failed';
    return { ok: false, error: message };
  }
}
