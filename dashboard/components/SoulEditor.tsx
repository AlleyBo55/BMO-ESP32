'use client';

import { useMemo, useState, useTransition } from 'react';

import { saveSoul } from '@/app/(admin)/soul/actions';

/**
 * Soul markdown editor.
 *
 * Client component. Renders a large monospace textarea with:
 *
 *   - live character count and a 64 KiB cap visualizer (red bar when over),
 *   - Save button that invokes the {@link saveSoul} server action,
 *   - inline status message ("Saving…", "Saved.", or the validation error),
 *   - last-saved timestamp,
 *   - dirty-tracking: Save is disabled when the content matches the initial
 *     value (no-op submits are silently dropped).
 *
 * The 64 KiB cap (`SOUL_MD_MAX_BYTES`) mirrors `lib/config.ts`. Counting
 * uses `string.length` (UTF-16 code units), which is what the server-side
 * validator also checks.
 */

const SOUL_MD_MAX_BYTES = 65_536;

interface SoulEditorProps {
  initialContent: string;
  /** ISO-8601 timestamp from `config.updated_at`. */
  updatedAt: string;
}

type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

export default function SoulEditor({
  initialContent,
  updatedAt,
}: SoulEditorProps): React.ReactElement {
  const [content, setContent] = useState<string>(initialContent);
  const [savedContent, setSavedContent] = useState<string>(initialContent);
  const [savedAt, setSavedAt] = useState<string>(updatedAt);
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle' });
  const [isPending, startTransition] = useTransition();

  const length = content.length;
  const overCap = length > SOUL_MD_MAX_BYTES;
  const dirty = content !== savedContent;
  const saving = isPending || status.kind === 'saving';
  const disabled = overCap || !dirty || saving;

  const usedPct = useMemo<number>(() => {
    if (length <= 0) return 0;
    const ratio = length / SOUL_MD_MAX_BYTES;
    return Math.min(100, Math.round(ratio * 100));
  }, [length]);

  const handleSave = (): void => {
    if (disabled) return;
    setStatus({ kind: 'saving' });
    const snapshot = content;
    startTransition(async () => {
      const result = await saveSoul(snapshot);
      if (result.ok) {
        setSavedContent(snapshot);
        setSavedAt(new Date().toISOString());
        setStatus({ kind: 'saved' });
      } else {
        setStatus({ kind: 'error', message: result.error });
      }
    });
  };

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-zinc-800 bg-zinc-900">
        <textarea
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            if (status.kind !== 'idle') setStatus({ kind: 'idle' });
          }}
          spellCheck={false}
          className="block min-h-[60vh] w-full resize-y rounded-lg bg-zinc-950 p-4 font-mono text-sm leading-6 text-zinc-100 placeholder-zinc-600 outline-none focus:ring-1 focus:ring-sky-500"
          placeholder="# Soul&#10;&#10;Describe BMO's persona…"
          aria-label="Soul markdown content"
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex flex-1 items-center gap-3">
          <div className="h-2 flex-1 max-w-xs overflow-hidden rounded bg-zinc-800">
            <div
              className={`h-full transition-all ${
                overCap ? 'bg-rose-500' : 'bg-sky-500'
              }`}
              style={{ width: `${overCap ? 100 : usedPct}%` }}
              aria-label={`${usedPct}% of soul cap used`}
            />
          </div>
          <span
            className={`font-mono ${overCap ? 'text-rose-400' : 'text-zinc-400'}`}
          >
            {length.toLocaleString()} / {SOUL_MD_MAX_BYTES.toLocaleString()}
            {overCap ? ' (over cap)' : ''}
          </span>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-zinc-500">
            Last saved: {formatTimestamp(savedAt)}
          </span>
          <button
            type="button"
            onClick={handleSave}
            disabled={disabled}
            className="rounded bg-sky-500 px-4 py-1.5 text-sm font-medium text-zinc-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      <div className="min-h-[1.25rem] text-xs">
        {status.kind === 'saved' ? (
          <span className="text-emerald-400">Saved.</span>
        ) : null}
        {status.kind === 'error' ? (
          <span className="text-rose-400">{status.message}</span>
        ) : null}
        {overCap && status.kind !== 'error' ? (
          <span className="text-rose-400">
            Over the {SOUL_MD_MAX_BYTES.toLocaleString()}-character cap. Trim before saving.
          </span>
        ) : null}
      </div>
    </div>
  );
}
