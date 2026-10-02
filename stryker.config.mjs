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
  // Measured: 87.7% overall (paths 80, redact 97, privacy 97, undo 100). The rest are Windows branches in paths.ts and equivalent
  // mutants. `break` sits just below and is only raised, never lowered.
  incrementalFile: 'reports/stryker-incremental.json',
  thresholds: { high: 95, low: 85, break: 85 },
};
