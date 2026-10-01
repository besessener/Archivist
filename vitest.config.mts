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
      // Electron-Einstiegspunkte laufen nur im Playwright-E2E (kein Node-Test kann sie laden)
      exclude: ['apps/desktop/src/main.ts', 'apps/desktop/src/preload.ts', 'packages/core/src/workers/worker-entry.ts', '**/*.d.ts'],
      reporter: ['text-summary', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
      // Gemessen am 2026-10: Statements 76,5 / Branches 61,6 / Functions 78,4 / Lines 81,4 (ohne die ausgeschlossenen Dateien).
      // Schwellen liegen bewusst knapp darunter; sie werden bei besserer Abdeckung nachgezogen (Ratchet), nie gesenkt.
      thresholds: { statements: 74, branches: 59, functions: 76, lines: 79 },
    },
  },
});
