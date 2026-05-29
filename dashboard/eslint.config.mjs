import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

/**
 * ESLint flat config for Next.js 15.
 *
 * - Extends `next/core-web-vitals`.
 * - Blocks server-only modules (`@/lib/supabase-admin` and the `serverEnv`
 *   export from `@/lib/env`) from being imported by client islands under
 *   `components/**`. Those files run in the browser; pulling a server-only
 *   module in would either bundle a service-role key into the browser or
 *   crash at build time. The bundle-secret scanner (`scripts/check-bundle
 *   -secrets.mjs`) is the second line of defense and runs in CI.
 *
 * Server code (anything under `app/**`, `lib/**`, `middleware.ts`) is NOT
 * covered by the restriction and may import these modules freely. Server
 * actions and server components live next to client islands inside
 * `app/(admin)/**`, so a folder-level rule there would produce noisy false
 * positives.
 */

const restrictedImportsRule = [
  'error',
  {
    paths: [
      {
        name: '@/lib/supabase-admin',
        message:
          'Service-role Supabase client is server-only. Import this only from server code (app/api/** or non-"use client" server components).',
      },
    ],
    patterns: [
      {
        group: ['@/lib/env'],
        importNames: ['serverEnv'],
        message:
          'serverEnv is server-only. Use publicEnv if you need a client-safe value, otherwise move the import into server-only code.',
      },
    ],
  },
];

const config = [
  ...compat.extends('next/core-web-vitals'),
  {
    files: ['components/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': restrictedImportsRule,
    },
  },
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'coverage/**',
      'next-env.d.ts',
    ],
  },
];

export default config;
