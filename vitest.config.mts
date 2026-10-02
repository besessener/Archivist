import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    isolate: false,
    fsModuleCache: true,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/desktop/src/**/*.ts'],
      // Electron entry points only run in the Playwright E2E tests (no Node test can load them)
      exclude: ['apps/desktop/src/main.ts', 'apps/desktop/src/preload.ts', 'packages/core/src/workers/worker-entry.ts', '**/*.d.ts'],
      reporter: ['text-summary', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
      // Measured in 2026-10: statements 76.5 / branches 61.6 / functions 78.4 / lines 81.4 (excluding the excluded files).
      // Thresholds are deliberately just below; they are raised as coverage improves (ratchet), never lowered.
      thresholds: { statements: 74, branches: 59, functions: 76, lines: 79 },
    },
  },
});
