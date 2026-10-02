/** Modules under mutation testing (see stryker.config.mjs). Only add new modules once their tests hold the score. */
export const MUTATE_TARGETS = [
  'packages/core/src/util/paths.ts',
  'packages/core/src/util/redact.ts',
  'packages/core/src/services/privacy.ts',
  'packages/core/src/services/undo.ts',
  'packages/core/src/agent/gate.ts',
  'packages/core/src/agent/security.ts',
  'packages/core/src/agent/history-privacy.ts',
  'packages/core/src/services/rename-pattern.ts',
  'packages/core/src/services/decision-fields.ts',
  'packages/core/src/services/open-item-fields.ts',
  'packages/core/src/agent/tools/research/deadlines.ts',
  'packages/core/src/agent/tools/research/amounts.ts',
  'packages/core/src/services/contradiction-rules.ts',
];
