/**
 * Property test for the activity-log sanitizer.
 *
 * fast-check generates strings that are guaranteed to contain at least one
 * banned-shape secret value. Property: after `writeActivityLog`, the persisted
 * row contains zero substrings matching any banned regex.
 *
 * The set of banned shapes mirrors the ones documented in `design.md` /
 * Property 14 — including secret-shape API keys, AWS access keys,
 * `Authorization: Bearer`, and JSON fields named `password` / `fingerprint`.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as fc from 'fast-check';

import {
  createMockServiceClient,
  getActivityLog,
  type MockServiceClient,
} from './mocks/supabase';

let mockClient: MockServiceClient;

vi.mock('@/lib/supabase-admin', () => ({
  getServiceClient: () => mockClient,
}));

beforeEach(() => {
  mockClient = createMockServiceClient();
});

const BANNED_REGEXES: ReadonlyArray<RegExp> = [
  /sk-ant-[A-Za-z0-9_-]{8,}/i,
  /sk-or-v1-[A-Za-z0-9_-]{8,}/i,
  /sk-proj-[A-Za-z0-9_-]{8,}/i,
  /AKIA[0-9A-Z]{12,}/,
  /Bearer\s+[A-Za-z0-9._-]{8,}/i,
  /"password"\s*:\s*"[^"]+"/i,
  /"fingerprint"\s*:\s*"[^"]+"/i,
];

const bannedShapeArb = fc.oneof(
  fc.string({ minLength: 12, maxLength: 32 }).map((s) => 'sk-ant-' + s.replace(/[^A-Za-z0-9_-]/g, 'a')),
  fc.string({ minLength: 12, maxLength: 32 }).map((s) => 'sk-or-v1-' + s.replace(/[^A-Za-z0-9_-]/g, 'a')),
  fc.string({ minLength: 12, maxLength: 32 }).map((s) => 'sk-proj-' + s.replace(/[^A-Za-z0-9_-]/g, 'a')),
  fc
    .stringMatching(/^[0-9A-Z]{12,16}$/)
    .map((s) => 'AKIA' + s),
  fc.string({ minLength: 8, maxLength: 64 }).map(
    (s) => 'Authorization: Bearer ' + s.replace(/[^A-Za-z0-9._-]/g, 'x'),
  ),
  fc.string({ minLength: 4, maxLength: 32 }).map(
    (s) => '{"password":"' + s.replace(/"/g, '') + '"}',
  ),
  fc.string({ minLength: 8, maxLength: 64 }).map(
    (s) => '{"fingerprint":"' + s.replace(/"/g, '') + '"}',
  ),
);

const interpolatedArb = fc
  .tuple(fc.string({ maxLength: 64 }), bannedShapeArb, fc.string({ maxLength: 64 }))
  .map(([prefix, banned, suffix]) => prefix + banned + suffix);

describe('writeActivityLog property: no banned regex survives sanitization', () => {
  test('forall interpolated strings, sanitized output contains zero banned matches', async () => {
    const log = await import('@/app/api/_lib/log');

    await fc.assert(
      fc.asyncProperty(interpolatedArb, async (s: string) => {
        // Reset mock state per shrink iteration so assertions stay isolated.
        mockClient = createMockServiceClient();

        await log.writeActivityLog({
          type: 'brain',
          input_text: s,
          reply_text: s,
          total_ms: 1,
          status: 'ok',
        });

        const rows = getActivityLog(mockClient);
        const row = rows[0];
        const stored = `${String(row?.['input_text'] ?? '')}\n${String(row?.['reply_text'] ?? '')}`;
        for (const re of BANNED_REGEXES) {
          if (re.test(stored)) {
            return false;
          }
        }
        return true;
      }),
      { numRuns: 100 },
    );
  });
});
