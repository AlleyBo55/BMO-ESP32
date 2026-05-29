import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { publicEnv } from '@/lib/env';

/**
 * Supabase client bound to the anon (public) key.
 *
 * Uses only `NEXT_PUBLIC_*` values. Safe to use in browser-reachable code
 * paths because the anon key respects RLS, which we set to `using (false)`
 * for every table — meaning anon reads are blocked at the database layer.
 *
 * Note: this module imports `@/lib/env` which is `server-only`. The anon
 * client is therefore only constructed server-side. If a future client
 * component needs anon access, it should read `process.env.NEXT_PUBLIC_*`
 * directly (those values are inlined by Next at build time).
 */

let cachedClient: SupabaseClient | null = null;

/**
 * Returns a lazily-initialized anon Supabase client, one per
 * Vercel function instance. Subsequent calls reuse the same client.
 */
export function getAnonClient(): SupabaseClient {
  if (cachedClient !== null) {
    return cachedClient;
  }

  cachedClient = createClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.supabaseClientKey,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      global: {
        headers: {
          'X-Client-Info': 'bmo-dashboard/anon',
        },
      },
    },
  );

  return cachedClient;
}
