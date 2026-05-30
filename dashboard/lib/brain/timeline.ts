import 'server-only';

import { brainWarn } from '@/lib/brain/contracts';
import { getServiceClient } from '@/lib/supabase-admin';

/**
 * Timeline / trajectory — how an entity changes over time (the "gbrain layer").
 *
 * This module reproduces gbrain's (https://github.com/garrytan/gbrain)
 * `find_trajectory` tool on the stack BMO already has. gbrain tracks how an
 * entity evolves by collecting the dated events attached to it — meetings,
 * milestones, changes — and replaying them in order. For BMO, a child's
 * companion toy, that same idea becomes a per-topic/per-entity timeline: the
 * biographical, emotional answer to "what has happened with X over time".
 *
 * Where 0003's brain_memory stores *what was said* and 0004's brain_graph
 * stores *what those memories are about*, this layer (backed by
 * public.brain_events from 0007_brain_timeline.sql) stores *how a topic moves
 * through time*: the child's feelings about school across weeks, recurring
 * activities, growth moments. {@link recordEvent} appends a dated point;
 * {@link trajectory} replays one entity chronologically; {@link recentEvents}
 * surfaces the newest activity across every entity.
 *
 * Graceful degradation (important): the timeline is an ENHANCEMENT, never a
 * hard dependency. Every function here degrades to a safe empty/null value and
 * logs a warning on any failure (missing table, insert error, malformed row).
 * Nothing throws, so a caller on the brain path can record or read trajectory
 * without risking the request.
 */

/** The kind of trajectory point — mirrors the brain_events.kind check. */
export type EventKind = 'milestone' | 'feeling' | 'activity' | 'change' | 'note';

/** A single dated event on an entity's timeline. Mirrors public.brain_events. */
export interface TimelineEvent {
  id: string;
  entity: string;
  kind: EventKind;
  summary: string;
  occurredAt: string;
}

/** Default number of points returned for a single entity's trajectory. */
const DEFAULT_TRAJECTORY_LIMIT = 50;
/** Default number of newest cross-entity events returned. */
const DEFAULT_RECENT_LIMIT = 20;

/** The allowed event kinds, used to validate defensively-parsed rows. */
const EVENT_KINDS: readonly EventKind[] = [
  'milestone',
  'feeling',
  'activity',
  'change',
  'note',
];

/** Narrows an arbitrary value to a known EventKind, defaulting to 'note'. */
function toEventKind(value: unknown): EventKind {
  return EVENT_KINDS.includes(value as EventKind) ? (value as EventKind) : 'note';
}

/**
 * Defensively maps one raw DB row into a TimelineEvent. Returns null when the
 * row is not a usable object or is missing its required string fields, so a
 * single malformed row never poisons a whole read.
 */
function parseRow(row: unknown): TimelineEvent | null {
  if (typeof row !== 'object' || row === null) return null;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.entity !== 'string') return null;
  if (typeof r.summary !== 'string') return null;
  return {
    id: r.id,
    entity: r.entity,
    kind: toEventKind(r.kind),
    summary: r.summary,
    occurredAt: typeof r.occurred_at === 'string' ? r.occurred_at : '',
  };
}

/* -------------------------------------------------------------------------- */
/* recordEvent — append a point to an entity's trajectory                      */
/* -------------------------------------------------------------------------- */

/**
 * Appends a dated event to an entity's timeline. Always resolves, never
 * throws: returns the new row id on success or null when the event was invalid
 * or the insert failed.
 *
 * `occurredAt` is an optional ISO timestamp for when the thing happened; omit
 * it to default to now (a freshly-observed event). Empty entity/summary are
 * rejected up front so trajectory reads never carry blank points.
 */
export async function recordEvent(
  entity: string,
  kind: EventKind,
  summary: string,
  occurredAt?: string,
): Promise<string | null> {
  const trimmedEntity = entity.trim();
  const trimmedSummary = summary.trim();
  if (trimmedEntity.length === 0 || trimmedSummary.length === 0) return null;

  try {
    const supabase = getServiceClient();
    const row: Record<string, string> = {
      entity: trimmedEntity,
      kind: toEventKind(kind),
      summary: trimmedSummary,
    };
    if (typeof occurredAt === 'string' && occurredAt.trim().length > 0) {
      row.occurred_at = occurredAt;
    }
    const { data, error } = await supabase
      .from('brain_events')
      .insert(row)
      .select('id')
      .single();
    if (error !== null) {
      brainWarn('timeline.recordEvent', error.message);
      return null;
    }
    if (data !== null && typeof data === 'object' && 'id' in data) {
      const id = (data as { id: unknown }).id;
      return typeof id === 'string' ? id : null;
    }
    return null;
  } catch (err) {
    brainWarn('timeline.recordEvent', err);
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* trajectory — replay one entity in chronological order                       */
/* -------------------------------------------------------------------------- */

/**
 * Returns one entity's events ordered chronologically (oldest first) so a
 * caller can read the trajectory as a story. The entity is matched
 * case-insensitively (ilike) so "School" and "school" share a timeline.
 *
 * Always resolves: returns an empty array on any failure or when the entity is
 * blank. `limit` caps how many points come back (default 50).
 */
export async function trajectory(
  entity: string,
  limit: number = DEFAULT_TRAJECTORY_LIMIT,
): Promise<TimelineEvent[]> {
  const trimmed = entity.trim();
  if (trimmed.length === 0) return [];
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_TRAJECTORY_LIMIT;

  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from('brain_events')
      .select('id, entity, kind, summary, occurred_at')
      .ilike('entity', trimmed)
      .order('occurred_at', { ascending: true })
      .limit(cap);
    if (error !== null) {
      brainWarn('timeline.trajectory', error.message);
      return [];
    }
    if (!Array.isArray(data)) return [];
    return data
      .map(parseRow)
      .filter((e): e is TimelineEvent => e !== null);
  } catch (err) {
    brainWarn('timeline.trajectory', err);
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* recentEvents — newest activity across every entity                          */
/* -------------------------------------------------------------------------- */

/**
 * Returns the newest events across all entities (most recent first), a quick
 * "what's been happening lately" view over the whole timeline. Always
 * resolves: returns an empty array on any failure. `limit` caps the result
 * (default 20).
 */
export async function recentEvents(
  limit: number = DEFAULT_RECENT_LIMIT,
): Promise<TimelineEvent[]> {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_RECENT_LIMIT;

  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from('brain_events')
      .select('id, entity, kind, summary, occurred_at')
      .order('occurred_at', { ascending: false })
      .limit(cap);
    if (error !== null) {
      brainWarn('timeline.recentEvents', error.message);
      return [];
    }
    if (!Array.isArray(data)) return [];
    return data
      .map(parseRow)
      .filter((e): e is TimelineEvent => e !== null);
  } catch (err) {
    brainWarn('timeline.recentEvents', err);
    return [];
  }
}
