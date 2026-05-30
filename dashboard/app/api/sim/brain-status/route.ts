import 'server-only';

import { requireAdmin } from '@/lib/api-auth';
import { brainSnapshot } from '@/lib/brain/index';

/**
 * GET /api/sim/brain-status — brain health + child profile snapshot.
 *
 * Browser-facing (admin session cookie). Surfaces the gbrain-style brain
 * core's self-diagnosis (`gbrain doctor` equivalent) plus the durable child
 * profile so the simulator can show whether the brain is actually wired up
 * (tables migrated, embeddings flowing, recall RPC live) and what BMO has
 * learned about the child.
 *
 * Always 200 with a snapshot — `brainSnapshot()` never throws and degrades to
 * a zeroed health + empty profile when the brain isn't set up yet.
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

export async function GET(req: Request): Promise<Response> {
  if (!(await requireAdmin(req))) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  const snapshot = await brainSnapshot();
  return jsonResponse(snapshot, 200);
}
