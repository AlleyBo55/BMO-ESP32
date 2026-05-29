'use server';

import { revalidatePath } from 'next/cache';

import { addSong, deleteSong, SongValidationError } from '@/lib/songs';

/**
 * Server actions for the Songs page.
 *
 * Both actions revalidate `/songs` after any successful mutation so the
 * list re-renders with the new state without a manual refresh.
 *
 * Validation lives in `lib/songs.ts`. Errors there throw
 * `SongValidationError`; we translate them into typed `{ ok: false }`
 * shapes so the page can render an inline message instead of an error
 * boundary round-trip.
 */

export type AddSongResult =
  | { ok: true }
  | { ok: false; error: string };

export async function addSongForm(formData: FormData): Promise<AddSongResult> {
  const title = String(formData.get('title') ?? '');
  const url = String(formData.get('url') ?? '');
  try {
    await addSong({ title, url });
    revalidatePath('/songs');
    return { ok: true };
  } catch (err) {
    if (err instanceof SongValidationError) {
      return { ok: false, error: err.message };
    }
    const message = err instanceof Error ? err.message : 'unknown error';
    return { ok: false, error: message };
  }
}

export type DeleteSongResult =
  | { ok: true }
  | { ok: false; error: string };

export async function deleteSongForm(
  formData: FormData,
): Promise<DeleteSongResult> {
  const id = String(formData.get('id') ?? '');
  if (id.length === 0) {
    return { ok: false, error: 'missing id' };
  }
  try {
    await deleteSong(id);
    revalidatePath('/songs');
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return { ok: false, error: message };
  }
}
