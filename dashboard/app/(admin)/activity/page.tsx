import Link from 'next/link';

import { getServiceClient } from '@/lib/supabase-admin';
import type { ActivityLogEntry } from '@/lib/types';

import { deleteActivityForm } from './actions';

/** Number of rows to display per page. */
const PAGE_SIZE = 50;

/**
 * In Next.js 15, `searchParams` arrives as a Promise. We only read `page`,
 * which can be a string, an array of strings, or undefined.
 */
interface ActivityPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function parsePage(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') {
    return 1;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 1;
  }
  return parsed;
}

/**
 * Activity log viewer (server component).
 *
 * Reads `?page=N` (default 1, 50 rows per page), fetches one extra row to
 * detect "has more", and renders a table with click-to-expand details
 * (using native `<details>` so the panel works without any client JS).
 *
 * Each row also gets a Delete form that posts to the `deleteActivity`
 * server action.
 */
export default async function ActivityPage({
  searchParams,
}: ActivityPageProps): Promise<React.ReactElement> {
  const params = await searchParams;
  const page = parsePage(params['page']);

  const offset = (page - 1) * PAGE_SIZE;

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('activity_log')
    .select(
      'id, created_at, type, input_text, reply_text, model_stt, model_llm, model_tts, total_ms, status, error_stage, error_message',
    )
    .order('created_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE);

  const rows: ActivityLogEntry[] = (data ?? []) as ActivityLogEntry[];
  const hasMore = rows.length > PAGE_SIZE;
  const visibleRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

  return (
    <>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3 md:mb-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">
            Activity log
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            One row per API request, newest first. Tap a row to see the
            transcript and reply.
          </p>
        </div>
        <div className="text-sm text-zinc-400">Page {page}</div>
      </header>

      {error !== null ? (
        <div className="mb-6 rounded-md border border-red-700 bg-red-950/40 px-4 py-3 text-sm text-red-200">
          Failed to load activity: {error.message}
        </div>
      ) : null}

      {visibleRows.length === 0 ? (
        <div className="rounded-md border border-zinc-800 bg-zinc-900/40 px-6 py-12 text-center text-sm text-zinc-400">
          No activity on this page.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-800">
          {/* Inner wrapper allows horizontal scroll on the smallest phones if
              hidden columns ever come back, while normal use stays inside the
              viewport thanks to the `hidden sm:table-cell` classes below. */}
          <div className="overflow-x-auto">
            <table className="w-full divide-y divide-zinc-800 text-left text-sm">
              <thead className="bg-zinc-900/60 text-xs uppercase tracking-wide text-zinc-400">
                <tr>
                  <th className="px-3 py-3 font-medium sm:px-4">Time</th>
                  <th className="px-3 py-3 font-medium sm:px-4">Type</th>
                  <th className="hidden px-4 py-3 font-medium md:table-cell">
                    STT
                  </th>
                  <th className="hidden px-4 py-3 font-medium md:table-cell">
                    LLM
                  </th>
                  <th className="hidden px-4 py-3 font-medium md:table-cell">
                    TTS
                  </th>
                  <th className="px-3 py-3 text-right font-medium sm:px-4">
                    ms
                  </th>
                  <th className="px-3 py-3 font-medium sm:px-4">Status</th>
                  <th className="hidden px-4 py-3 font-medium sm:table-cell">
                    Stage
                  </th>
                  <th className="px-3 py-3 font-medium sm:px-4" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800 bg-zinc-950/40">
                {visibleRows.map((row) => (
                  <ActivityRow key={row.id} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <nav className="mt-6 flex items-center justify-between text-sm">
        {page > 1 ? (
          <Link
            href={{ pathname: '/activity', query: { page: page - 1 } }}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-200 transition hover:bg-zinc-800"
          >
            ← Newer
          </Link>
        ) : (
          <span />
        )}

        {hasMore ? (
          <Link
            href={{ pathname: '/activity', query: { page: page + 1 } }}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-200 transition hover:bg-zinc-800"
          >
            Older →
          </Link>
        ) : (
          <span />
        )}
      </nav>
    </>
  );
}

interface ActivityRowProps {
  row: ActivityLogEntry;
}

/**
 * Renders the summary row plus a hidden `<tr>` containing the expanded
 * transcript/reply panel. We use a `<details>` element wrapping the toggle
 * cell so this works without any client JS.
 */
function ActivityRow({ row }: ActivityRowProps): React.ReactElement {
  const timestamp = formatTimestamp(row.created_at);
  const statusClass =
    row.status === 'ok'
      ? 'bg-emerald-950/60 text-emerald-300 ring-emerald-700/50'
      : 'bg-red-950/60 text-red-300 ring-red-700/50';

  return (
    <>
      <tr className="align-top">
        <td className="px-4 py-3 font-mono text-xs text-zinc-300">
          {timestamp}
        </td>
        <td className="px-4 py-3 text-zinc-100">{row.type}</td>
        <td className="px-4 py-3 text-zinc-400">{row.model_stt ?? '—'}</td>
        <td className="px-4 py-3 text-zinc-400">{row.model_llm ?? '—'}</td>
        <td className="px-4 py-3 text-zinc-400">{row.model_tts ?? '—'}</td>
        <td className="px-4 py-3 text-right font-mono text-zinc-200">
          {row.total_ms}
        </td>
        <td className="px-4 py-3">
          <span
            className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${statusClass}`}
          >
            {row.status}
          </span>
        </td>
        <td className="px-4 py-3 text-xs text-zinc-400">
          {row.error_stage ?? '—'}
        </td>
        <td className="px-4 py-3 text-right">
          <form action={deleteActivityForm}>
            <input type="hidden" name="id" value={row.id} />
            <button
              type="submit"
              className="rounded-md border border-red-800/80 bg-red-950/30 px-2.5 py-1 text-xs font-medium text-red-200 transition hover:bg-red-900/40"
              aria-label={`Delete activity ${row.id}`}
            >
              Delete
            </button>
          </form>
        </td>
      </tr>
      <tr>
        <td colSpan={9} className="px-4 pb-4 pt-0">
          <details className="group rounded-md border border-zinc-800 bg-zinc-900/40">
            <summary className="cursor-pointer select-none px-4 py-2 text-xs font-medium text-zinc-400 transition hover:text-zinc-200">
              <span className="group-open:hidden">Show transcript ▸</span>
              <span className="hidden group-open:inline">Hide transcript ▾</span>
            </summary>
            <div className="space-y-3 border-t border-zinc-800 px-4 py-3">
              <DetailBlock
                label="Input"
                value={row.input_text}
              />
              <DetailBlock
                label="Reply"
                value={row.reply_text}
              />
              {row.error_message !== null ? (
                <DetailBlock
                  label="Error"
                  value={row.error_message}
                  tone="error"
                />
              ) : null}
            </div>
          </details>
        </td>
      </tr>
    </>
  );
}

interface DetailBlockProps {
  label: string;
  value: string | null;
  tone?: 'normal' | 'error';
}

function DetailBlock({
  label,
  value,
  tone = 'normal',
}: DetailBlockProps): React.ReactElement {
  const toneClass =
    tone === 'error'
      ? 'border-red-800 bg-red-950/30 text-red-200'
      : 'border-zinc-800 bg-zinc-950/60 text-zinc-200';
  return (
    <div>
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      <pre
        className={`max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border px-3 py-2 font-mono text-xs ${toneClass}`}
      >
        {value ?? '—'}
      </pre>
    </div>
  );
}

function formatTimestamp(iso: string): string {
  // Render as a stable, locale-independent UTC string so server and client
  // hydration match without needing a client component.
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
}
