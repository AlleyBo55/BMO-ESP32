import { NextResponse, type NextRequest } from 'next/server';

import { readSession } from '@/lib/auth-session';
import { getServiceClient } from '@/lib/supabase-admin';

/**
 * Onboarding gate + admin auth gate.
 *
 * Logic order (matches design.md "Middleware" section):
 *
 *   1. Skip middleware entirely for static and firmware-API paths. Those
 *      routes (`/api/voice/*`, `/api/brain`, `/api/openrouter/*`) authenticate
 *      themselves via the `X-BMO-Fingerprint` header and have no use for the
 *      session cookie or the onboarding redirect.
 *   2. Read the singleton-row admin count, cached for 30 seconds per Vercel
 *      function instance to avoid hammering Supabase on hot paths.
 *   3. If admin count is zero, force every reachable route to `/onboarding`.
 *      `/onboarding` itself is allowed through.
 *   4. If admin count is one or more, `/onboarding` returns a hard 404 (the
 *      route is gone forever once setup completes), `/` and `/login` are
 *      allowed through, and every other path requires a valid session cookie.
 *      Valid sessions get an `x-bmo-username` request header forwarded
 *      downstream so admin pages can render the username without re-reading
 *      the cookie.
 *
 * The matcher excludes `_next/static`, `_next/image`, and `favicon.ico`
 * outright. The runtime checks below add the other skips.
 */

interface AdminCountCache {
  count: number;
  fetchedAt: number;
}

const ADMIN_COUNT_TTL_MS = 30_000;

let adminCountCache: AdminCountCache | null = null;

const SKIP_PREFIXES: readonly string[] = [
  '/_next',
  '/api/voice/',
  '/api/brain',
  '/api/openrouter/',
];

const SKIP_EXACT: readonly string[] = ['/favicon.ico'];

/** True if this request belongs to a path that handles its own auth. */
function shouldSkipMiddleware(pathname: string): boolean {
  if (SKIP_EXACT.includes(pathname)) {
    return true;
  }
  for (const prefix of SKIP_PREFIXES) {
    if (pathname.startsWith(prefix)) {
      return true;
    }
  }
  // Top-level static assets (e.g. /robots.txt, /sitemap.xml) — anything that
  // looks like a file with an extension. Not a perfect match but defensive.
  if (/\.[a-zA-Z0-9]+$/.test(pathname)) {
    return true;
  }
  return false;
}

async function getAdminCount(): Promise<number> {
  const now = Date.now();
  if (
    adminCountCache !== null &&
    now - adminCountCache.fetchedAt < ADMIN_COUNT_TTL_MS
  ) {
    return adminCountCache.count;
  }
  const supabase = getServiceClient();
  const { count, error } = await supabase
    .from('admin')
    .select('*', { count: 'exact', head: true });
  if (error !== null) {
    // Surface every bit of Supabase's error envelope so misconfigurations
    // (missing tables, wrong key, wrong project URL) are obvious in dev.
    const detail = [
      error.message,
      error.code !== undefined ? `code=${error.code}` : null,
      error.details !== undefined && error.details !== null
        ? `details=${error.details}`
        : null,
      error.hint !== undefined && error.hint !== null
        ? `hint=${error.hint}`
        : null,
    ]
      .filter((s): s is string => s !== null && s.length > 0)
      .join(' | ');
    throw new Error(
      `middleware admin count query failed: ${detail || '(no message returned by supabase-js — check NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are set and that the schema in supabase/schema.sql has been applied)'}`,
    );
  }
  const value = count ?? 0;
  // Only cache the *terminal* state (admin row exists). The pre-onboarding
  // "no admins" state is transient: as soon as the operator finishes the
  // onboarding form an admin row appears, and a stale "0" cache here would
  // bounce them straight back to /onboarding from /login. Re-querying for
  // every request while count==0 is fine — that path only exists for the
  // first few minutes of a project's life.
  if (value > 0) {
    adminCountCache = { count: value, fetchedAt: now };
  } else {
    adminCountCache = null;
  }
  return value;
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;

  if (shouldSkipMiddleware(pathname)) {
    return NextResponse.next();
  }

  const adminCount = await getAdminCount();

  // ------------------------------------------------------------------
  // Pre-onboarding: zero admins exist. Funnel everything to /onboarding.
  // ------------------------------------------------------------------
  if (adminCount === 0) {
    if (pathname === '/onboarding') {
      return NextResponse.next();
    }
    const redirectUrl = req.nextUrl.clone();
    redirectUrl.pathname = '/onboarding';
    redirectUrl.search = '';
    return NextResponse.redirect(redirectUrl);
  }

  // ------------------------------------------------------------------
  // Post-onboarding: admin row exists. Onboarding is gone, login open,
  // everything else requires a session.
  // ------------------------------------------------------------------
  if (pathname === '/onboarding') {
    return new NextResponse('not_found', { status: 404 });
  }

  if (pathname === '/' || pathname === '/wiki' || pathname === '/login') {
    return NextResponse.next();
  }

  const session = await readSession(req);
  if (session === null) {
    const redirectUrl = req.nextUrl.clone();
    redirectUrl.pathname = '/login';
    redirectUrl.search = '';
    return NextResponse.redirect(redirectUrl);
  }

  const forwardedHeaders = new Headers(req.headers);
  forwardedHeaders.set('x-bmo-username', session.username);
  return NextResponse.next({
    request: { headers: forwardedHeaders },
  });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
