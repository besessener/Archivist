import { MUTATE_TARGETS } from './mutation-targets.mjs';

/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
export default {
  packageManager: 'npm',
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.mutation.config.mts' },
  coverageAnalysis: 'perTest',
  // Targeted: only modules where an unnoticed bug would be expensive (path safety, secrets, privacy gate, undo).
  mutate: MUTATE_TARGETS,
  reporters: ['clear-text', 'progress', 'json', 'html'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  timeoutMS: 30_000,
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
  // Ratchet below the measured 87.7 % (the rest: Windows branches in paths.ts, equivalent mutants): only raised, never lowered.
  incrementalFile: 'reports/stryker-incremental.json',
  thresholds: { high: 95, low: 85, break: 85 },
};
