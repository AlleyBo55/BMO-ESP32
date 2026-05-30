import 'server-only';

import { runDreamCycle } from '@/lib/brain/consolidate';

/**
 * POST /api/brain/dream — the gbrain "dream cycle" trigger.
 *
 * The real gbrain (github.com/garrytan/gbrain) runs a 24/7 cron daemon that
 * dedups, (re)scores salience, and enriches memory while the user sleeps.
 * BMO has no persistent host, so we expose that enrichment pass as an
 * on-demand endpoint meant to be hit by **Vercel Cron** (see vercel.json) on
 * a schedule — or manually for an immediate pass.
 *
 * Auth is a shared-secret bearer token, the convention Vercel Cron uses:
 * the platform sends `Authorization: Bearer <CRON_SECRET>` on scheduled
 * invocations. We compare that header against `process.env.CRON_SECRET`.
 * If `CRON_SECRET` is unset, or the header is missing/mismatched, we reject
 * with 401 — an unset secret fails closed so we never run the cycle wide open.
 *
 * On success we run `runDreamCycle()` (which never throws and degrades to a
 * zero-count report on failure) and return the `DreamReport` as JSON 200.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Constant-ish bearer check against CRON_SECRET. Fails closed when the
 * secret is unset so an unconfigured deploy can't run the cycle unauthed.
 */
function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (typeof secret !== 'string' || secret.length === 0) {
    return false;
  }
  const header = req.headers.get('authorization');
  if (header === null) {
    return false;
  }
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) {
    return false;
  }
  return header.slice(prefix.length) === secret;
}

export async function POST(req: Request): Promise<Response> {
  if (!isAuthorized(req)) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  const report = await runDreamCycle();
  return jsonResponse(report, 200);
}

/**
 * GET handler for Vercel Cron, which invokes scheduled endpoints with GET and
 * sends `Authorization: Bearer <CRON_SECRET>`. Shares the same auth + body as
 * POST so the cron and a manual `curl -X POST` behave identically.
 */
export async function GET(req: Request): Promise<Response> {
  return POST(req);
}
