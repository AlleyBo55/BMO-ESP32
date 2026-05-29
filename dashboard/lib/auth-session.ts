/**
 * Edge-safe session helpers.
 *
 * Only depends on `jose`, which works in the Next.js Edge runtime where
 * Node native modules (argon2, supabase-admin, node:crypto's expensive
 * primitives) cannot run. Anything that needs a native dependency lives
 * in `lib/auth.ts` and must be imported only from server (Node) routes.
 *
 * No `import 'server-only'` here on purpose — middleware (Edge runtime)
 * needs to call `readSession`, and `'server-only'` is satisfied by Edge
 * just fine, but we avoid the directive so this stays maximally portable.
 * It is still server-bound by virtue of holding the `AUTH_SESSION_SECRET`.
 */

import { SignJWT, jwtVerify } from 'jose';

import type { SessionPayload } from '@/lib/types';

/** Public cookie name. Imported by middleware and the login server action. */
export const SESSION_COOKIE_NAME = 'bmo_session';

/** 24 hours, in seconds. Mirrors the JWT `exp` claim. */
const SESSION_TTL_SECONDS = 24 * 60 * 60;

function getSecretKey(): Uint8Array {
  const secret = process.env.AUTH_SESSION_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error(
      'AUTH_SESSION_SECRET must be set and at least 32 characters long.',
    );
  }
  return new TextEncoder().encode(secret);
}

function buildCookie(name: string, value: string, maxAgeSeconds: number): string {
  // Browsers refuse to store a `Secure` cookie over plain HTTP, which is
  // what `next dev` serves. Drop the flag in development so the cookie
  // sticks; production builds keep it on.
  const secureFlag = process.env.NODE_ENV === 'production' ? 'Secure' : null;
  const parts: Array<string | null> = [
    `${name}=${value}`,
    'HttpOnly',
    secureFlag,
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
  ];
  return parts.filter((p): p is string => p !== null).join('; ');
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (header === null || header.length === 0) {
    return null;
  }
  const parts = header.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx);
    if (key !== name) continue;
    const raw = trimmed.slice(eqIdx + 1);
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/**
 * Issues a signed JWT session cookie for the given admin username.
 * Returns the full `Set-Cookie` header value (without the `Set-Cookie:` prefix).
 */
export async function issueSessionCookie(username: string): Promise<string> {
  const jwt = await new SignJWT({ username })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(getSecretKey());
  return buildCookie(SESSION_COOKIE_NAME, jwt, SESSION_TTL_SECONDS);
}

/**
 * Reads and verifies the session cookie from a Next.js Request.
 * Returns `null` for missing, malformed, expired, or tampered cookies.
 */
export async function readSession(req: Request): Promise<SessionPayload | null> {
  const token = readCookie(req, SESSION_COOKIE_NAME);
  if (token === null || token.length === 0) {
    return null;
  }
  try {
    const { payload } = await jwtVerify(token, getSecretKey(), {
      algorithms: ['HS256'],
    });
    const username = payload['username'];
    if (typeof username !== 'string' || username.length === 0) {
      return null;
    }
    const iat = typeof payload.iat === 'number' ? payload.iat : 0;
    return { username, iat };
  } catch {
    return null;
  }
}

/**
 * Returns the `Set-Cookie` value that immediately expires the session cookie.
 * Mounted at logout and on session-tamper detection.
 */
export async function clearSessionCookie(): Promise<string> {
  return buildCookie(SESSION_COOKIE_NAME, '', 0);
}
