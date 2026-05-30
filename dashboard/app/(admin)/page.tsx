import CreditsLive from '@/components/CreditsLive';
import { getServiceClient } from '@/lib/supabase-admin';
import type { ActivityLogEntry } from '@/lib/types';

/**
 * Admin home page.
 *
 * Server-rendered. Performs a single fast server-side fetch (recent activity
 * from Supabase) and renders immediately. The OpenRouter credit balance is
 * NOT fetched here on purpose: it used to block the entire HTML response on a
 * network hop to OpenRouter (up to a 10s timeout) on every navigation, which
 * made the dashboard feel sluggish. {@link CreditsLive} now fetches the
 * balance client-side on mount (and polls every 60s), hitting the
 * `/api/openrouter/credits` route which memoizes the upstream call for 30s.
 */

export const dynamic = 'force-dynamic';

async function loadRecentActivity(): Promise<ActivityLogEntry[]> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('activity_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(10);
  if (error !== null) {
    return [];
  }
  if (!Array.isArray(data)) {
    return [];
  }
  return data as ActivityLogEntry[];
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

function statusBadgeClass(status: ActivityLogEntry['status']): string {
  return status === 'ok'
    ? 'inline-block rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-400'
    : 'inline-block rounded bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-rose-400';
}

export default async function HomePage(): Promise<React.ReactElement> {
  const activity = await loadRecentActivity();

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold text-zinc-100">Home</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Live OpenRouter balance and recent device activity.
        </p>
      </header>

      <CreditsLive initialData={null} initialStale={false} />

      <section className="rounded-lg border border-zinc-800 bg-zinc-900">
        <div className="border-b border-zinc-800 px-5 py-3">
          <h2 className="text-sm font-semibold text-zinc-300">Recent activity</h2>
          <p className="mt-0.5 text-xs text-zinc-500">Latest 10 requests.</p>
        </div>

        {activity.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-zinc-500 sm:px-5">
            No activity yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-zinc-900/40 text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-3 py-2 text-left font-medium sm:px-5">Timestamp</th>
                  <th className="px-3 py-2 text-left font-medium sm:px-5">Type</th>
                  <th className="px-3 py-2 text-right font-medium sm:px-5">ms</th>
                  <th className="px-3 py-2 text-left font-medium sm:px-5">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {activity.map((row) => (
                  <tr key={row.id} className="hover:bg-zinc-900/60">
                    <td className="px-3 py-2 font-mono text-xs text-zinc-300 sm:px-5">
                      {formatTimestamp(row.created_at)}
                    </td>
                    <td className="px-3 py-2 text-zinc-300 sm:px-5">{row.type}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-zinc-300 sm:px-5">
                      {row.total_ms}
                    </td>
                    <td className="px-3 py-2 sm:px-5">
                      <span className={statusBadgeClass(row.status)}>
                        {row.status}
                      </span>
                      {row.error_stage !== null && row.error_stage !== undefined ? (
                        <span className="ml-2 text-xs text-zinc-500">
                          ({row.error_stage})
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
