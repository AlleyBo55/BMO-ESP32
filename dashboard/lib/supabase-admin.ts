import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { publicEnv, serverEnv } from '@/lib/env';

/**
 * Server-only Supabase client using the service-role key.
 *
 * This client bypasses RLS and is therefore the only path to the `admin`,
 * `config`, `activity_log`, and `auth_attempts` tables.
 *
 * The raw client is intentionally NOT exported. Consumers must call
 * `getServiceClient()` so the singleton stays under our control and we can
 * adjust auth/options without rippling through call sites.
 */

let cachedClient: SupabaseClient | null = null;

/**
 * Returns a lazily-initialized service-role Supabase client, one per
 * Vercel function instance. Subsequent calls reuse the same client.
 */
export function getServiceClient(): SupabaseClient {
  if (cachedClient !== null) {
    return cachedClient;
  }

  cachedClient = createClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    serverEnv.supabaseSecretKey,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      global: {
        headers: {
          'X-Client-Info': 'bmo-dashboard/service-role',
        },
      },
    },
  );

  return cachedClient;
}
