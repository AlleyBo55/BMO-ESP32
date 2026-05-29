import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Vitest configuration for the BMO Dashboard test suite.
 *
 * - `node` is the default environment (every API/lib test runs server-side).
 *   React component tests, when added later, can opt into `jsdom` via the
 *   per-file `// @vitest-environment jsdom` pragma.
 * - The setup file installs deterministic env vars and mocks for
 *   `next/headers` and `server-only` so that server-only modules import
 *   cleanly under Vitest.
 * - `@/...` resolves to the project root, matching the `paths` entry in
 *   `tsconfig.json` so source imports work uniformly inside tests.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    setupFiles: ['./__tests__/setup.ts'],
    include: ['__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['lib/**', 'app/api/**'],
      reporter: ['text', 'html', 'lcov'],
    },
    pool: 'forks',
    clearMocks: true,
    restoreMocks: true,
  },
});
