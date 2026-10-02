/** Modules under mutation testing (see stryker.config.mjs). Only add new modules once their tests hold the score. */
export const MUTATE_TARGETS = [
  'packages/core/src/util/paths.ts',
  'packages/core/src/util/redact.ts',
  'packages/core/src/services/privacy.ts',
  'packages/core/src/services/undo.ts',
];
