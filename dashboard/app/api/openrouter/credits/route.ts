import 'server-only';

import { verifyFingerprint } from '@/app/api/_lib/fingerprint-guard';
import { readSession } from '@/lib/auth';
import { fetchCredits, OpenRouterError, type CreditsResponse } from '@/lib/openrouter';

/**
 * GET /api/openrouter/credits
 *
 * Returns the OpenRouter credit balance. Two authentication paths:
 *
 *   1. The dashboard home page polls this from the browser using the
 *      session cookie. `readSession()` returns a non-null payload.
 *   2. The firmware (or any future operator tool) calls this with the
 *      `X-BMO-Fingerprint` header. `verifyFingerprint()` returns ok.
 *
 * If neither succeeds, respond with 401.
 *
 * The response body is `{ total, used, remaining, currency, fetchedAt }`. On
 * upstream failure, if a previous successful body is cached (TTL: 30s), we
 * return that body with `stale: true` appended. Otherwise we return 502 with
 * `{ error, stage: 'credits' }`.
 *
 * The cache is module-scoped and therefore lives for the lifetime of the
 * Vercel function instance. That gives us per-instance memoization without
 * a shared cache layer.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Per-instance cache TTL: 30 seconds. */
const CREDITS_CACHE_TTL_MS = 30_000;

interface CreditsCache {
  value: CreditsResponse;
  fetchedAt: number;
}

let cache: CreditsCache | null = null;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

async function isAuthorized(req: Request): Promise<boolean> {
  const session = await readSession(req);
  if (session !== null) {
    return true;
  }
  const guard = await verifyFingerprint(req);
  return guard.ok;
}

export async function GET(req: Request): Promise<Response> {
  if (!(await isAuthorized(req))) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  const now = Date.now();
  if (cache !== null && now - cache.fetchedAt < CREDITS_CACHE_TTL_MS) {
    return jsonResponse(cache.value, 200);
  }

  try {
    const fresh = await fetchCredits();
    cache = { value: fresh, fetchedAt: now };
    return jsonResponse(fresh, 200);
  } catch (err) {
    if (cache !== null) {
      // Hand back the last good body but flag it as stale so the UI can
      // surface a "couldn't refresh" badge.
      return jsonResponse({ ...cache.value, stale: true }, 200);
    }
    const message =
      err instanceof OpenRouterError
        ? err.message
        : err instanceof Error
        ? err.message
        : 'unknown error';
    return jsonResponse({ stage: 'credits', error: message }, 502);
  }
}
