'use server';

import { ConfigValidationError, updateConfig } from '@/lib/config';

/**
 * Server action invoked by the soul editor's Save button.
 *
 * Returns a discriminated `{ ok }` shape rather than throwing so the
 * client component can render an inline error without an error boundary
 * round-trip. All structural validation (including the 64 KiB cap) lives in
 * `updateConfig` / `validateConfigPatch`; we just translate the typed
 * exception into a plain message.
 */
export async function saveSoul(
  content: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (typeof content !== 'string') {
    return { ok: false, error: 'soul content must be a string' };
  }
  try {
    await updateConfig({ soul_md: content });
    return { ok: true };
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      return { ok: false, error: err.message };
    }
    const message = err instanceof Error ? err.message : 'unknown error';
    return { ok: false, error: message };
  }
}
