import 'server-only';

import { readSession } from '@/lib/auth';

/**
 * Shared authentication helpers for API routes.
 *
 * Firmware-facing routes (`/api/brain`, `/api/voice/*`) authenticate with the
 * `X-BMO-Fingerprint` header via {@link verifyFingerprint}. Browser-facing
 * admin routes (the simulator under `/api/sim/*`, the credits poller)
 * authenticate with the admin session cookie instead.
 *
 * `requireAdmin` centralizes the "is this a logged-in admin?" check so the
 * simulator routes don't each re-implement the session read.
 */

/** True when the request carries a valid admin session cookie. */
export async function requireAdmin(req: Request): Promise<boolean> {
  const session = await readSession(req);
  return session !== null;
}
