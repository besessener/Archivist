import { defineConfig } from 'vitest/config';

// Evaluation of the agent with real models (#316): costs money, never part of `npm test` or CI.
// Only tests/eval/**/*.eval.ts, one task after another, with long timeouts.
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
