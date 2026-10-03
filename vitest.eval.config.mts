import { defineConfig } from 'vitest/config';

// Agent evaluation with real models (#316): costs money, never part of `npm test` or CI; one task after another.
export default defineConfig({
  test: {
    include: ['tests/eval/**/*.eval.ts'],
    environment: 'node',
    testTimeout: 30 * 60_000,
    hookTimeout: 10 * 60_000,
    pool: 'forks',
    fileParallelism: false,
    sequence: { concurrent: false, shuffle: false },
    maxConcurrency: 1,
    reporters: ['default'],
  },
});
