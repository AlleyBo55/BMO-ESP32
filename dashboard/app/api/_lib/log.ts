import 'server-only';

import { getServiceClient } from '@/lib/supabase-admin';

/**
 * Activity-log writer.
 *
 * Every request to the firmware-facing API routes (`/api/voice/stt`,
 * `/api/voice/tts`, `/api/brain`) ends with exactly one row in
 * `activity_log`. We sanitize string fields against a list of secret-shape
 * regexes (API keys, bearer tokens, fingerprints, password literals) and
 * truncate the two free-text fields to 8 KiB each.
 *
 * `sanitizeRow` is exported so the unit tests can hit the redaction logic
 * without standing up a Supabase client.
 */

/** Maximum byte size for `input_text` and `reply_text` after sanitization. */
const TEXT_BYTE_CAP = 8 * 1024;

/** Replacement token written in place of any matched secret-shape substring. */
const REDACTION = '[redacted]';

export interface ActivityLogRow {
  type: 'stt' | 'tts' | 'brain';
  input_text?: string;
  reply_text?: string;
  model_stt?: string;
  model_llm?: string;
  model_tts?: string;
  total_ms: number;
  status: 'ok' | 'error';
  error_stage?: 'stt' | 'llm' | 'tts';
  error_message?: string;
}

/**
 * Secret-shape patterns. Any substring of any string field that matches one
 * of these is replaced with `[redacted]`. Patterns intentionally cover both
 * known-good provider key prefixes and likely structural shapes.
 */
const SECRET_PATTERNS: readonly RegExp[] = Object.freeze([
  /sk-(ant|or|proj|live)-[a-z0-9_-]{8,}/gi,
  /aoaAA[A-Za-z0-9_-]{10,}/g,
  /aorAA[A-Za-z0-9_-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /ASIA[0-9A-Z]{16}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /Authorization:\s*Bearer\s+\S+/gi,
  /password['"]?\s*[:=]/gi,
  /fingerprint['"]?\s*[:=]\s*['"]?[A-Fa-f0-9+/=]{20,}/gi,
  /api[_-]?key['"]?\s*[:=]/gi,
]);

function redactString(value: string): string {
  let result = value;
  for (const pattern of SECRET_PATTERNS) {
    // RegExp objects above use the `g` flag; reset lastIndex to be safe under
    // any future mutation. `replace` doesn't depend on lastIndex but still.
    pattern.lastIndex = 0;
    result = result.replace(pattern, REDACTION);
  }
  return result;
}

/**
 * UTF-8 byte-length truncation. Keeps the result valid UTF-8 by trimming a
 * trailing partial multi-byte sequence.
 */
function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) {
    return value;
  }
  let cut = maxBytes;
  // Walk back over any continuation bytes (10xxxxxx) so we don't slice a
  // multi-byte sequence in half.
  while (cut > 0) {
    const byte = bytes[cut];
    if (byte === undefined) break;
    if ((byte & 0xc0) !== 0x80) break;
    cut -= 1;
  }
  const decoder = new TextDecoder('utf-8', { fatal: false });
  return decoder.decode(bytes.subarray(0, cut));
}

/**
 * Returns a deep copy of `row` with every string field run through
 * `redactString`, plus `input_text` and `reply_text` truncated to
 * `TEXT_BYTE_CAP` bytes after redaction.
 */
export function sanitizeRow(row: ActivityLogRow): ActivityLogRow {
  const cleaned: ActivityLogRow = {
    type: row.type,
    total_ms: row.total_ms,
    status: row.status,
  };

  if (row.input_text !== undefined) {
    cleaned.input_text = truncateUtf8(redactString(row.input_text), TEXT_BYTE_CAP);
  }
  if (row.reply_text !== undefined) {
    cleaned.reply_text = truncateUtf8(redactString(row.reply_text), TEXT_BYTE_CAP);
  }
  if (row.model_stt !== undefined) {
    cleaned.model_stt = redactString(row.model_stt);
  }
  if (row.model_llm !== undefined) {
    cleaned.model_llm = redactString(row.model_llm);
  }
  if (row.model_tts !== undefined) {
    cleaned.model_tts = redactString(row.model_tts);
  }
  if (row.error_stage !== undefined) {
    cleaned.error_stage = row.error_stage;
  }
  if (row.error_message !== undefined) {
    cleaned.error_message = redactString(row.error_message);
  }

  return cleaned;
}

/**
 * Sanitizes the row and inserts it into `activity_log` via the service-role
 * client. Throws on Supabase error so the route handler can surface the
 * failure (the writer itself is fire-and-forget enough that callers usually
 * await inside a `finally` block).
 */
export async function writeActivityLog(row: ActivityLogRow): Promise<void> {
  const sanitized = sanitizeRow(row);
  const supabase = getServiceClient();
  const { error } = await supabase.from('activity_log').insert(sanitized);
  if (error !== null) {
    throw new Error(`writeActivityLog insert failed: ${error.message}`);
  }
}
