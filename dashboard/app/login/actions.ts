'use server';

import { cookies } from 'next/headers';

import {
  clearAttempts,
  isLockedOut,
  issueSessionCookie,
  recordFailedAttempt,
  verifyPassword,
} from '@/lib/auth';
import { getServiceClient } from '@/lib/supabase-admin';

/**
 * Login server action.
 *
 * Honors the rolling 15-minute, 5-attempt lockout window. Returns the same
 * generic `invalid_credentials` error for every authentication failure
 * (missing user, wrong password) so the response cannot be used to enumerate
 * which usernames exist.
 *
 * On success: clears the user's failed-attempts rows, sets the session
 * cookie via Next 15's `cookies()` API, and returns `{ ok: true }`. The
 * client component is responsible for the post-success navigation. We do NOT
 * call `redirect()` here because Next 15's `useActionState` swallows the
 * thrown NEXT_REDIRECT when the action is invoked via a client wrapper,
 * which freezes the form's pending state forever.
 */

export type LoginResult =
  | { ok: true }
  | { ok: false; error: 'invalid_credentials' | 'rate_limited' };

export async function login(input: {
  username: string;
  password: string;
}): Promise<LoginResult> {
  const username = input.username.trim();

  // Lockout check first so attackers can't keep probing past the threshold.
  if (await isLockedOut(username)) {
    return { ok: false, error: 'rate_limited' };
  }

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('admin')
    .select('id, username, password_hash')
    .eq('username', username)
    .maybeSingle<{ id: number; username: string; password_hash: string }>();

  if (error !== null) {
    throw new Error(`login admin lookup failed: ${error.message}`);
  }

  if (data === null) {
    await recordFailedAttempt(username);
    return { ok: false, error: 'invalid_credentials' };
  }

  const passwordOk = await verifyPassword(input.password, data.password_hash);
  if (!passwordOk) {
    await recordFailedAttempt(username);
    return { ok: false, error: 'invalid_credentials' };
  }

  await clearAttempts(username);

  const cookieValue = await issueSessionCookie(data.username);
  const parsed = parseSetCookie(cookieValue);

  const cookieStore = await cookies();
  // `Secure` is required by browsers for cross-site cookies but they refuse
  // to store a Secure cookie over plain HTTP — which is exactly what
  // `next dev` serves. Only enforce Secure in production.
  const isSecureContext = process.env.NODE_ENV === 'production';
  cookieStore.set({
    name: parsed.name,
    value: parsed.value,
    httpOnly: true,
    secure: isSecureContext,
    sameSite: 'lax',
    path: '/',
    maxAge: parsed.maxAge,
  });

  return { ok: true };
}

interface ParsedSetCookie {
  name: string;
  value: string;
  maxAge: number;
}

/**
 * Splits a `Set-Cookie` header value (without the `Set-Cookie:` prefix) into
 * the bits Next.js's `cookies().set()` API wants. We only pull out the name,
 * value, and Max-Age — everything else is set explicitly above.
 */
function parseSetCookie(raw: string): ParsedSetCookie {
  const parts = raw.split(';').map((p) => p.trim());
  const head = parts[0] ?? '';
  const eqIdx = head.indexOf('=');
  const name = eqIdx === -1 ? head : head.slice(0, eqIdx);
  const value = eqIdx === -1 ? '' : head.slice(eqIdx + 1);

  let maxAge = 24 * 60 * 60;
  for (const part of parts.slice(1)) {
    const [k, v] = part.split('=');
    if (k !== undefined && k.toLowerCase() === 'max-age' && v !== undefined) {
      const parsedAge = Number.parseInt(v, 10);
      if (Number.isFinite(parsedAge) && parsedAge >= 0) {
        maxAge = parsedAge;
      }
    }
  }
  return { name, value, maxAge };
}
