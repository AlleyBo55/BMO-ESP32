'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { SESSION_COOKIE_NAME } from '@/lib/auth';

/**
 * Logs the admin out by deleting the session cookie and redirecting to /login.
 *
 * Used by the sidebar's logout button (`<form action={logout}>`). Works
 * without client JS thanks to Next.js server actions / progressive
 * enhancement.
 */
export async function logout(): Promise<never> {
  const store = await cookies();
  // Mirror the Secure-flag handling from login: dev runs over plain HTTP
  // and browsers refuse to set a Secure cookie there, including the empty
  // expiring cookie we use for logout.
  const isSecureContext = process.env.NODE_ENV === 'production';
  store.set({
    name: SESSION_COOKIE_NAME,
    value: '',
    httpOnly: true,
    secure: isSecureContext,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  redirect('/login');
}
