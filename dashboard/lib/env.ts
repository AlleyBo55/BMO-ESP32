import 'server-only';

import { z } from 'zod';

/**
 * Validated, typed access to environment variables.
 *
 * - `publicEnv` exposes only `NEXT_PUBLIC_*` values that are safe for any
 *   reader (still inlined by Next at build time).
 * - `serverEnv` exposes server-only secrets (Supabase secret/service-role
 *   key, OpenRouter API key, JWT signing secret).
 *
 * Supabase renamed its API keys in late 2024:
 *   - `anon` public key → `publishable` key (still public)
 *   - `service_role` secret key → `secret` key (still server-only)
 * Both name pairs are accepted here so the dashboard works with whatever
 * the Supabase dashboard currently surfaces. Internally we always read the
 * resolved value through `publicEnv.supabaseClientKey` and
 * `serverEnv.supabaseSecretKey` so the rest of the codebase doesn't care
 * which spelling the operator pasted.
 *
 * The first line `import 'server-only'` ensures Webpack/Turbopack throws if
 * any client component or any module that ends up in a client bundle imports
 * this file. ESLint also blocks `serverEnv` from client-reachable paths.
 *
 * Validation runs once at module init. A missing or malformed required value
 * throws a descriptive error with the bad keys listed.
 */

function pickEnv(...names: ReadonlyArray<string>): string | undefined {
  for (const name of names) {
    const v = process.env[name];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  // The browser-safe Supabase key. Either spelling is accepted; we resolve
  // it before zod sees it so the schema only checks the resolved value.
  supabaseClientKey: z.string().min(20, {
    message:
      'Set NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (or legacy NEXT_PUBLIC_SUPABASE_ANON_KEY).',
  }),
});

const serverSchema = z.object({
  // The server-only Supabase key. Either spelling is accepted.
  supabaseSecretKey: z.string().min(20, {
    message:
      'Set SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY).',
  }),
  OPENROUTER_API_KEY: z.string().min(20),
  AUTH_SESSION_SECRET: z.string().min(32),
});

function formatIssues(error: z.ZodError): string {
  return error.errors
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}

const publicResult = publicSchema.safeParse({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  supabaseClientKey: pickEnv(
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  ),
});

if (!publicResult.success) {
  throw new Error(
    `Invalid public environment variables. Check .env.local against .env.example:\n${formatIssues(
      publicResult.error,
    )}`,
  );
}

const serverResult = serverSchema.safeParse({
  supabaseSecretKey: pickEnv(
    'SUPABASE_SECRET_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
  ),
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  AUTH_SESSION_SECRET: process.env.AUTH_SESSION_SECRET,
});

if (!serverResult.success) {
  throw new Error(
    `Invalid server environment variables. Check .env.local against .env.example:\n${formatIssues(
      serverResult.error,
    )}`,
  );
}

/** Read-only public env values (NEXT_PUBLIC_*). */
export const publicEnv: Readonly<z.infer<typeof publicSchema>> = Object.freeze(
  publicResult.data,
);

/** Read-only server-only env values. NEVER reference from client components. */
export const serverEnv: Readonly<z.infer<typeof serverSchema>> = Object.freeze(
  serverResult.data,
);

export type PublicEnv = typeof publicEnv;
export type ServerEnv = typeof serverEnv;
