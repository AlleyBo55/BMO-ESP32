'use server';

import { revalidatePath } from 'next/cache';

import { getConfig, updateConfig } from '@/lib/config';
import type { SkillName, SkillState } from '@/lib/types';

/**
 * Server actions for the skills page.
 *
 * Both actions read the current `config.skills`, patch a single skill, and
 * write the merged map back via `updateConfig`. Validation that the supplied
 * `name` is a real `SkillName` happens here (string from a `<select>` /
 * hidden input) so the database never receives garbage keys.
 */

const SKILL_NAMES: ReadonlyArray<SkillName> = [
  'web_search',
  'sing',
  'play_music',
  'story',
  'comfort',
  'play_pretend',
  'memory',
  'random_thoughts',
];

const SKILL_NAME_SET: ReadonlySet<string> = new Set<string>(SKILL_NAMES);

function isSkillName(value: string): value is SkillName {
  return SKILL_NAME_SET.has(value);
}

/**
 * Toggles the `enabled` flag on a single skill.
 *
 * Preserves the existing `params` (if any) and any other skill rows that
 * happen to be present.
 */
export async function setSkillEnabled(
  name: SkillName,
  enabled: boolean,
): Promise<{ ok: boolean }> {
  if (!isSkillName(name)) {
    return { ok: false };
  }
  const cfg = await getConfig();
  const existing: SkillState = cfg.skills[name] ?? { enabled: false };
  const next: SkillState = { enabled };
  if (existing.params !== undefined) {
    next.params = existing.params;
  }
  await updateConfig({
    skills: { ...cfg.skills, [name]: next },
  });
  revalidatePath('/skills');
  return { ok: true };
}

/**
 * Replaces the `params` bag for a single skill.
 *
 * Preserves the existing `enabled` flag.
 */
export async function setSkillParams(
  name: SkillName,
  params: Record<string, unknown>,
): Promise<{ ok: boolean }> {
  if (!isSkillName(name)) {
    return { ok: false };
  }
  const cfg = await getConfig();
  const existing: SkillState = cfg.skills[name] ?? { enabled: false };
  const next: SkillState = { enabled: existing.enabled, params };
  await updateConfig({
    skills: { ...cfg.skills, [name]: next },
  });
  revalidatePath('/skills');
  return { ok: true };
}

/**
 * Form-action wrapper for the toggle row.
 *
 * The form posts `name` and (optionally) `enabled=on` for a checkbox-style
 * control. We map "checkbox present" to `true`, "checkbox absent" to `false`.
 * Returns void so the server action can be used directly as a `<form action>`
 * with progressive enhancement.
 */
export async function toggleSkillForm(formData: FormData): Promise<void> {
  const rawName = formData.get('name');
  const rawEnabled = formData.get('enabled');
  if (typeof rawName !== 'string' || !isSkillName(rawName)) {
    return;
  }
  const enabled = rawEnabled === 'true' || rawEnabled === 'on' || rawEnabled === '1';
  await setSkillEnabled(rawName, enabled);
}

/**
 * Form-action wrapper for the params editor.
 *
 * Reads `name` and `params` (a JSON string in a textarea). On parse failure
 * the action exits silently — the page re-fetches the unchanged row.
 */
export async function saveSkillParamsForm(formData: FormData): Promise<void> {
  const rawName = formData.get('name');
  const rawParams = formData.get('params');
  if (typeof rawName !== 'string' || !isSkillName(rawName)) {
    return;
  }
  if (typeof rawParams !== 'string') {
    return;
  }
  const trimmed = rawParams.trim();
  if (trimmed.length === 0) {
    await setSkillParams(rawName, {});
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return;
  }
  await setSkillParams(rawName, parsed as Record<string, unknown>);
}
