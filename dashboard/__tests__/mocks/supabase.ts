/**
 * In-memory Supabase service-role client mock.
 *
 * Implements just enough of the PostgREST builder API to back the dashboard's
 * tables under test:
 *
 *   - `.from(table).select('*')`
 *   - `.from(table).select('*').eq('col', val)`
 *   - `.from(table).select('*').eq(...).single()`
 *   - `.from(table).select('*').order('col', { ascending: false }).limit(n)`
 *   - `.from(table).insert(rowOrRows)`
 *   - `.from(table).upsert(row)` (singleton id=1 tables)
 *   - `.from(table).update(patch).eq(...)` / `.update(patch)`
 *   - `.from(table).delete().eq(...)` / `.delete().lt(...)`
 *
 * The mock returns shapes Supabase callers expect: `{ data, error }` for
 * terminal calls; chainable builder objects in the middle. Each call is
 * tracked on `client.calls` for fine-grained assertions.
 *
 * `vi.mock('@/lib/supabase-admin', ...)` should swap the real
 * `getServiceClient` for the result of `createMockServiceClient()` per test,
 * keeping per-test state isolated.
 */

import { vi } from 'vitest';

export type TableName = 'admin' | 'config' | 'activity_log' | 'auth_attempts';

export interface MockRow {
  [key: string]: unknown;
}

export interface MockTables {
  admin: MockRow[];
  config: MockRow[];
  activity_log: MockRow[];
  auth_attempts: MockRow[];
}

export interface MockServiceClient {
  /** Backing storage; tests may seed and inspect freely. */
  tables: MockTables;
  /** Recorded fluent calls, useful for "no insert happened" assertions. */
  calls: Array<{ table: TableName; op: string; payload?: unknown }>;
  from(table: TableName): QueryBuilder;
}

interface QueryBuilder {
  select(columns?: string, options?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }): QueryBuilder;
  insert(rows: MockRow | MockRow[]): QueryBuilder;
  upsert(row: MockRow, options?: { onConflict?: string; ignoreDuplicates?: boolean }): QueryBuilder;
  update(patch: MockRow): QueryBuilder;
  delete(): QueryBuilder;
  eq(column: string, value: unknown): QueryBuilder;
  neq(column: string, value: unknown): QueryBuilder;
  gt(column: string, value: unknown): QueryBuilder;
  gte(column: string, value: unknown): QueryBuilder;
  lt(column: string, value: unknown): QueryBuilder;
  lte(column: string, value: unknown): QueryBuilder;
  order(column: string, options?: { ascending?: boolean }): QueryBuilder;
  limit(count: number): QueryBuilder;
  single(): Promise<{ data: MockRow | null; error: { message: string } | null }>;
  maybeSingle(): Promise<{ data: MockRow | null; error: { message: string } | null }>;
  // Builders are awaitable: `await client.from('x').select('*')`.
  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>;
}

interface QueryResult {
  data: MockRow[] | MockRow | null;
  error: { message: string } | null;
  count?: number | null;
}

type Filter = (row: MockRow) => boolean;
type SortSpec = { column: string; ascending: boolean };

interface BuilderState {
  table: TableName;
  op: 'select' | 'insert' | 'upsert' | 'update' | 'delete' | null;
  filters: Filter[];
  rowsToInsert?: MockRow[];
  rowToUpsert?: MockRow;
  upsertIgnoreDuplicates?: boolean;
  patch?: MockRow;
  sort?: SortSpec;
  limit?: number;
  countMode?: 'exact' | 'planned' | 'estimated';
}

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

function applyFilters(rows: MockRow[], filters: Filter[]): MockRow[] {
  return rows.filter((row) => filters.every((f) => f(row)));
}

function nextId(rows: MockRow[]): number {
  let max = 0;
  for (const row of rows) {
    const id = row['id'];
    if (typeof id === 'number' && id > max) max = id;
  }
  return max + 1;
}

export function createMockServiceClient(): MockServiceClient {
  const tables: MockTables = {
    admin: [],
    config: [],
    activity_log: [],
    auth_attempts: [],
  };
  const calls: MockServiceClient['calls'] = [];

  function makeBuilder(table: TableName): QueryBuilder {
    const state: BuilderState = {
      table,
      op: null,
      filters: [],
    };

    function executeTerminal(): QueryResult {
      const data = tables[state.table];

      if (state.op === 'insert' && state.rowsToInsert) {
        const inserted: MockRow[] = state.rowsToInsert.map((row) => {
          const withId: MockRow = {
            id: row['id'] ?? nextId(data),
            created_at: row['created_at'] ?? new Date().toISOString(),
            ...row,
          };
          data.push(withId);
          return withId;
        });
        return { data: inserted, error: null };
      }

      if (state.op === 'upsert' && state.rowToUpsert) {
        const row = state.rowToUpsert;
        const id = row['id'] ?? 1;
        const existingIdx = data.findIndex((r) => r['id'] === id);
        if (existingIdx >= 0) {
          if (state.upsertIgnoreDuplicates === true) {
            // PostgREST `INSERT ... ON CONFLICT DO NOTHING`: returns no rows.
            return { data: [], error: null };
          }
          data[existingIdx] = { ...(data[existingIdx] ?? {}), ...row, id };
          return { data: data[existingIdx] ?? null, error: null };
        }
        const inserted: MockRow = {
          id,
          created_at: new Date().toISOString(),
          ...row,
        };
        data.push(inserted);
        return { data: inserted, error: null };
      }

      if (state.op === 'update' && state.patch) {
        const matched = applyFilters(data, state.filters);
        for (const row of matched) {
          Object.assign(row, state.patch);
        }
        return { data: matched, error: null };
      }

      if (state.op === 'delete') {
        const matched = applyFilters(data, state.filters);
        for (const row of matched) {
          const idx = data.indexOf(row);
          if (idx >= 0) data.splice(idx, 1);
        }
        return { data: matched, error: null };
      }

      // Default: select
      let rows = applyFilters(data, state.filters);
      if (state.sort) {
        const sort = state.sort;
        rows = [...rows].sort((a, b) => {
          const cmp = compareValues(a[sort.column], b[sort.column]);
          return sort.ascending ? cmp : -cmp;
        });
      }
      if (typeof state.limit === 'number') {
        rows = rows.slice(0, state.limit);
      }
      const result: QueryResult = { data: rows, error: null };
      if (state.countMode) {
        result.count = applyFilters(data, state.filters).length;
      }
      return result;
    }

    const builder: QueryBuilder = {
      select(_columns, options) {
        state.op = state.op ?? 'select';
        if (options?.count) state.countMode = options.count;
        calls.push({ table, op: 'select' });
        return builder;
      },
      insert(rows) {
        state.op = 'insert';
        state.rowsToInsert = Array.isArray(rows) ? rows : [rows];
        calls.push({ table, op: 'insert', payload: rows });
        return builder;
      },
      upsert(row, options) {
        state.op = 'upsert';
        state.rowToUpsert = row;
        if (options?.ignoreDuplicates === true) state.upsertIgnoreDuplicates = true;
        calls.push({ table, op: 'upsert', payload: row });
        return builder;
      },
      update(patch) {
        state.op = 'update';
        state.patch = patch;
        calls.push({ table, op: 'update', payload: patch });
        return builder;
      },
      delete() {
        state.op = 'delete';
        calls.push({ table, op: 'delete' });
        return builder;
      },
      eq(column, value) {
        state.filters.push((row) => row[column] === value);
        return builder;
      },
      neq(column, value) {
        state.filters.push((row) => row[column] !== value);
        return builder;
      },
      gt(column, value) {
        state.filters.push((row) => compareValues(row[column], value) > 0);
        return builder;
      },
      gte(column, value) {
        state.filters.push((row) => compareValues(row[column], value) >= 0);
        return builder;
      },
      lt(column, value) {
        state.filters.push((row) => compareValues(row[column], value) < 0);
        return builder;
      },
      lte(column, value) {
        state.filters.push((row) => compareValues(row[column], value) <= 0);
        return builder;
      },
      order(column, options) {
        state.sort = { column, ascending: options?.ascending ?? false };
        return builder;
      },
      limit(count) {
        state.limit = count;
        return builder;
      },
      async single() {
        const res = executeTerminal();
        const arr = Array.isArray(res.data) ? res.data : res.data ? [res.data] : [];
        const first = arr[0] ?? null;
        return { data: first, error: arr.length === 0 ? { message: 'no rows' } : null };
      },
      async maybeSingle() {
        const res = executeTerminal();
        const arr = Array.isArray(res.data) ? res.data : res.data ? [res.data] : [];
        return { data: arr[0] ?? null, error: null };
      },
      then(onfulfilled, onrejected) {
        try {
          const result = executeTerminal();
          return Promise.resolve(result).then(onfulfilled, onrejected);
        } catch (err) {
          return Promise.reject(err).then(onfulfilled, onrejected);
        }
      },
    };

    return builder;
  }

  return {
    tables,
    calls,
    from(table) {
      return makeBuilder(table);
    },
  };
}

/** Seed an admin row at id=1. */
export function seedAdmin(
  client: MockServiceClient,
  row: { username: string; password_hash: string },
): void {
  client.tables.admin.push({
    id: 1,
    username: row.username,
    password_hash: row.password_hash,
    created_at: new Date().toISOString(),
  });
}

/** Seed (or replace) the singleton config row. */
export function seedConfig(
  client: MockServiceClient,
  row: Partial<{
    fingerprint_hash: string;
    soul_md: string;
    skills: Record<string, { enabled: boolean; params?: Record<string, unknown> }>;
    llm_model: string;
    stt_model: string;
    tts_model: string;
    tts_voice: string;
  }>,
): void {
  const existingIdx = client.tables.config.findIndex((r) => r['id'] === 1);
  const merged: MockRow = {
    id: 1,
    soul_md: row.soul_md ?? '',
    skills: row.skills ?? {},
    fingerprint_hash: row.fingerprint_hash ?? '',
    llm_model: row.llm_model ?? 'openai/gpt-4.1-mini',
    stt_model: row.stt_model ?? 'qwen/qwen3-asr-flash-2026-02-10',
    tts_model: row.tts_model ?? 'openai/gpt-audio-mini',
    tts_voice: row.tts_voice ?? 'nova',
    updated_at: new Date().toISOString(),
  };
  if (existingIdx >= 0) {
    client.tables.config[existingIdx] = merged;
  } else {
    client.tables.config.push(merged);
  }
}

/** Convenience accessor for the activity log table. */
export function getActivityLog(client: MockServiceClient): MockRow[] {
  return client.tables.activity_log;
}

/** Insert a synthetic auth_attempts row. Callers control timestamps. */
export function seedAuthAttempt(
  client: MockServiceClient,
  username: string,
  attemptedAtIso: string,
): void {
  client.tables.auth_attempts.push({
    id: client.tables.auth_attempts.length + 1,
    username,
    attempted_at: attemptedAtIso,
  });
}
