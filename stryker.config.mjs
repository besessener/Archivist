import { MUTATE_TARGETS } from './mutation-targets.mjs';

/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
export default {
  packageManager: 'npm',
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.mutation.config.mts' },
  coverageAnalysis: 'perTest',
  // Bedarfsgerecht: nur Module, bei denen ein unbemerkter Fehler teuer wäre (Pfadsicherheit, Secrets, Datenschutz-Gate, Undo).
  mutate: MUTATE_TARGETS,
  reporters: ['clear-text', 'progress', 'json', 'html'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  timeoutMS: 30_000,
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
  // Gemessen: 87,7 % gesamt (paths 80, redact 97, privacy 97, undo 100). Der Rest sind Windows-Zweige in paths.ts und gleichwertige
  // Mutanten. `break` liegt knapp darunter und wird nur angehoben, nie gesenkt.
  incrementalFile: 'reports/stryker-incremental.json',
  thresholds: { high: 95, low: 85, break: 85 },
};
