'use server';

import { revalidatePath } from 'next/cache';

import { getServiceClient } from '@/lib/supabase-admin';

/**
 * Deletes a single row from the `activity_log` table.
 *
 * The activity log is otherwise append-only; this is the one explicit
 * single-row delete the design permits, invoked from the Delete button on
 * the activity page.
 */
export async function deleteActivity(id: number): Promise<{ ok: boolean }> {
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false };
  }

  const supabase = getServiceClient();
  const { error } = await supabase.from('activity_log').delete().eq('id', id);

  if (error !== null) {
    return { ok: false };
  }

  // Refresh the activity page so the deleted row disappears immediately.
  revalidatePath('/activity');
  return { ok: true };
}

/**
 * Form-action wrapper around `deleteActivity` for use as the `action`
 * attribute on a `<form>`. Reads `id` from the FormData and discards the
 * return value so the type matches Next.js's `(formData) => void` shape.
 */
export async function deleteActivityForm(formData: FormData): Promise<void> {
  const raw = formData.get('id');
  if (typeof raw !== 'string') {
    return;
  }
  const id = Number.parseInt(raw, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return;
  }
  await deleteActivity(id);
}
