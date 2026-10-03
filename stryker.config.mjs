import { MUTATE_TARGETS } from './mutation-targets.mjs';

/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
export default {
  packageManager: 'npm',
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.mutation.config.mts' },
  coverageAnalysis: 'perTest',
  // Targeted: modules where an unnoticed bug would be expensive (path safety, secrets, privacy and agent gate, undo, pure domain rules).
  mutate: MUTATE_TARGETS,
  reporters: ['clear-text', 'progress', 'json', 'html'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  timeoutMS: 30_000,
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
  // Full run measured 97.2 % (the rest: equivalent mutants); the thresholds are only raised, never lowered.
  thresholds: { high: 95, low: 95, break: 95 },
};
