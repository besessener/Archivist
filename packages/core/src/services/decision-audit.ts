import type { DecisionRow } from './decision-fields';

/** Columns whose old and new values the audit log keeps, so the history of a decision shows what changed. */
const TRACKED_COLUMNS = ['title', 'decisionText', 'decidedAt', 'validFrom', 'validUntil', 'rationale', 'consequences', 'sourceIds'] as const;

/** The tracked columns an edit changes, with their values before and after. */
export function trackedChanges(current: DecisionRow, set: Partial<DecisionRow>): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const column of TRACKED_COLUMNS) {
    const next = set[column];
    if (next === undefined || JSON.stringify(next) === JSON.stringify(current[column])) continue;
    before[column] = current[column];
    after[column] = next;
  }
  return { before, after };
}
