/** Module unter Mutationstest (siehe stryker.config.mjs). Neue Module erst aufnehmen, wenn ihre Tests den Wert halten. */
export const MUTATE_TARGETS = [
  'packages/core/src/util/paths.ts',
  'packages/core/src/util/redact.ts',
  'packages/core/src/services/privacy.ts',
  'packages/core/src/services/undo.ts',
];
