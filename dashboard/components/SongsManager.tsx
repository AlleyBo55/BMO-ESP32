'use client';

import { useMemo, useState, useTransition } from 'react';
import type { FormEvent } from 'react';

import {
  addSongForm,
  deleteSongForm,
  type AddSongResult,
  type DeleteSongResult,
} from '@/app/(admin)/songs/actions';
import type { Song } from '@/lib/types';

/**
 * Songs catalog UI.
 *
 * Client island for the `/songs` page. Renders:
 *
 *   - an "Add a song" form (title + https URL),
 *   - a card list of existing songs, each with a delete button,
 *   - inline error/success feedback on every action.
 *
 * Mutations go through the server actions in `./actions.ts`. After each
 * successful action the parent `revalidatePath('/songs')` call refreshes
 * the server-rendered list, which we mirror locally so the UI feels
 * instant.
 */

interface SongsManagerProps {
  initialSongs: Song[];
}

interface AddState {
  kind: 'idle' | 'saving' | 'saved' | 'error';
  message?: string;
}

interface DeleteState {
  pendingId: string | null;
  error: string | null;
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

export default function SongsManager({
  initialSongs,
}: SongsManagerProps): React.ReactElement {
  const [songs, setSongs] = useState<Song[]>(initialSongs);
  const [addState, setAddState] = useState<AddState>({ kind: 'idle' });
  const [deleteState, setDeleteState] = useState<DeleteState>({
    pendingId: null,
    error: null,
  });
  const [isAdding, startAddTransition] = useTransition();
  const [, startDeleteTransition] = useTransition();

  const handleAdd = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (isAdding) return;
    const form = event.currentTarget;
    const formData = new FormData(form);

    setAddState({ kind: 'saving' });
    startAddTransition(async () => {
      const result: AddSongResult = await addSongForm(formData);
      if (result.ok) {
        // Optimistically prepend a placeholder; the next server fetch will
        // replace it with the real row including the generated id.
        const tempTitle = String(formData.get('title') ?? '').trim();
        const tempUrl = String(formData.get('url') ?? '').trim();
        setSongs((prev) => [
          {
            id: `__pending_${Date.now()}`,
            title: tempTitle,
            url: tempUrl,
            added_at: new Date().toISOString(),
          },
          ...prev,
        ]);
        form.reset();
        setAddState({ kind: 'saved' });
      } else {
        setAddState({ kind: 'error', message: result.error });
      }
    });
  };

  const handleDelete = (id: string): void => {
    if (deleteState.pendingId !== null) return;
    setDeleteState({ pendingId: id, error: null });
    startDeleteTransition(async () => {
      const formData = new FormData();
      formData.set('id', id);
      const result: DeleteSongResult = await deleteSongForm(formData);
      if (result.ok) {
        setSongs((prev) => prev.filter((s) => s.id !== id));
        setDeleteState({ pendingId: null, error: null });
      } else {
        setDeleteState({ pendingId: null, error: result.error });
      }
    });
  };

  const sortedSongs = useMemo<Song[]>(
    () =>
      [...songs].sort(
        (a, b) =>
          new Date(b.added_at).getTime() - new Date(a.added_at).getTime(),
      ),
    [songs],
  );

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
        <h2 className="text-sm font-semibold text-zinc-300">Add a song</h2>
        <p className="mt-0.5 text-xs text-zinc-500">
          Paste a publicly reachable HTTPS URL to an audio file. The
          dashboard never downloads on your behalf — it streams on-demand
          when the device asks for the song.
        </p>

        <form onSubmit={handleAdd} className="mt-4 space-y-3">
          <div>
            <label
              htmlFor="title"
              className="mb-1 block text-xs font-medium text-zinc-300"
            >
              Title
            </label>
            <input
              id="title"
              name="title"
              type="text"
              required
              maxLength={200}
              disabled={isAdding}
              placeholder="Lullaby in C"
              className="w-full rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none disabled:opacity-60"
            />
          </div>

          <div>
            <label
              htmlFor="url"
              className="mb-1 block text-xs font-medium text-zinc-300"
            >
              HTTPS URL
            </label>
            <input
              id="url"
              name="url"
              type="url"
              required
              pattern="https://.*"
              disabled={isAdding}
              placeholder="https://r2.example.com/songs/lullaby.mp3"
              className="w-full rounded border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none disabled:opacity-60"
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={isAdding}
              className="rounded bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isAdding ? 'Adding…' : 'Add song'}
            </button>
            {addState.kind === 'saved' ? (
              <span className="text-xs text-emerald-400">Added.</span>
            ) : null}
            {addState.kind === 'error' ? (
              <span className="text-xs text-rose-400">{addState.message}</span>
            ) : null}
          </div>
        </form>
      </section>

      <section className="rounded-lg border border-zinc-800 bg-zinc-900">
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <h2 className="text-sm font-semibold text-zinc-300">Catalog</h2>
          <span className="text-xs text-zinc-500">
            {sortedSongs.length} {sortedSongs.length === 1 ? 'song' : 'songs'}
          </span>
        </div>

        {deleteState.error !== null ? (
          <div className="border-b border-zinc-800 px-5 py-2 text-xs text-rose-400">
            Delete failed: {deleteState.error}
          </div>
        ) : null}

        {sortedSongs.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-zinc-500">
            No songs yet. Add one above.
          </div>
        ) : (
          <ul className="divide-y divide-zinc-800">
            {sortedSongs.map((song) => {
              const isPendingDelete = deleteState.pendingId === song.id;
              const isPendingAdd = song.id.startsWith('__pending_');
              return (
                <li
                  key={song.id}
                  className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-zinc-100">
                      {song.title}
                    </div>
                    <a
                      href={song.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="mt-0.5 block truncate font-mono text-xs text-sky-400 hover:underline"
                    >
                      {song.url}
                    </a>
                    <div className="mt-1 text-[11px] text-zinc-500">
                      Added {formatTimestamp(song.added_at)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDelete(song.id)}
                    disabled={isPendingDelete || isPendingAdd}
                    className="shrink-0 rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 transition hover:border-rose-500 hover:text-rose-400 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isPendingDelete ? 'Removing…' : 'Remove'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
