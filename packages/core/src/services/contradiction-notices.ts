import type { Decision, StoredAgentAction } from '@archivist/shared';
import type { contradictions } from '../db/schema';
import type { ArchivistJson } from '../util/json';
import { truncate } from '../util/text';
import type { ActionService } from './actions';
import type { DecisionOrder } from './decision-dating';
import type { InsightService } from './insights';
import type { NotificationService } from './notifications';

export type ContradictionRow = typeof contradictions.$inferSelect;

/** What a contradiction between two decisions shows: both texts in their order, and how to settle an unknown order. */
export function pairContent(
  order: DecisionOrder,
  { reason, topic }: { reason: string; topic: string },
): Pick<ContradictionRow, 'title' | 'description' | 'affectedEntityIds' | 'excerpts' | 'sourceIds' | 'timestamps'> {
  const { older, newer, ordered, label } = order;
  const orderNote = ordered
    ? ''
    : '\n\nWelche Entscheidung die neuere ist, ist unbekannt – ergänze ein Entscheidungsdatum oder markiere die überholte Entscheidung auf ihrer Seite als „ersetzt“.';
  return {
    title: `Mögliche widersprüchliche Entscheidungen zu „${topic}“`,
    description: `${reason}\n\n1. ${label(older)}: ${truncate(older.decisionText, 240)}\n2. ${label(newer)}: ${truncate(newer.decisionText, 240)}${orderNote}`,
    affectedEntityIds: [older.id, newer.id],
    excerpts: [
      { entityId: older.id, text: truncate(older.decisionText, 300) },
      { entityId: newer.id, text: truncate(newer.decisionText, 300) },
    ] as ArchivistJson,
    sourceIds: [...new Set([...older.sourceIds, ...newer.sourceIds, older.id, newer.id])],
    timestamps: [older, newer].flatMap((d) => order.dateOf(d) ?? []),
  };
}

/** The newer decision supersedes the older one – only as a proposal the user confirms. */
export function proposeSupersede(actions: ActionService, { order, confidence }: { order: DecisionOrder; confidence: number }): StoredAgentAction {
  const { older, newer, label } = order;
  return actions.propose({
    actionType: 'supersede_decision',
    rationale: `Die neuere Entscheidung (${label(newer)}) könnte die ältere (${label(older)}) überholt haben.`,
    confidence,
    affectedEntities: [
      { type: 'decision', id: older.id, label: older.title },
      { type: 'decision', id: newer.id, label: newer.title },
    ],
    requiredConfirmation: 'confirm',
    proposedParameters: { oldDecisionId: older.id, newDecisionId: newer.id },
    label: 'Neuere Entscheidung ersetzt die ältere (ältere als überholt markieren)',
  });
}

/** Insight and notification of a new contradiction. */
export function announce(
  deps: { insights: InsightService; notifications: NotificationService },
  row: ContradictionRow,
  found: { older: Decision; newer: Decision; action: StoredAgentAction | null },
): void {
  const { older, newer, action } = found;
  deps.insights.upsert({
    kind: 'contradiction',
    title: row.title,
    explanation: row.description,
    confidence: row.confidence,
    affected: [
      { type: 'decision', id: older.id, label: older.title },
      { type: 'decision', id: newer.id, label: newer.title },
    ],
    sourceIds: row.sourceIds,
    ...(action ? { recommendedActionId: action.id, recommendedActionLabel: 'Neuere Entscheidung ersetzt die ältere' } : {}),
    dedupeKey: `contradiction:${row.id}`,
  });
  deps.notifications.create({
    title: 'Möglicher Widerspruch erkannt',
    description: row.title,
    type: 'contradiction',
    priority: 'high',
    affectedEntityIds: [older.id, newer.id],
    proposedActions: [
      { label: 'Insights öffnen', kind: 'navigate', target: '/insights/' },
      ...(action ? [{ label: 'Ersetzen bestätigen', kind: 'confirm_action' as const, target: action.id }] : []),
    ],
    dedupeKey: `contradiction:${row.id}`,
  });
}

/** Insight and notification of a new contradiction between two documents; there is nothing to supersede, the user reads both and decides. */
export function announceDocuments(
  deps: { insights: InsightService; notifications: NotificationService },
  row: ContradictionRow,
  documents: Array<{ id: string; title: string }>,
): void {
  deps.insights.upsert({
    kind: 'contradiction',
    title: row.title,
    explanation: row.description,
    confidence: row.confidence,
    affected: documents.map(({ id, title }) => ({ type: 'document' as const, id, label: title })),
    sourceIds: row.sourceIds,
    dedupeKey: `contradiction:${row.id}`,
  });
  deps.notifications.create({
    title: 'Möglicher Widerspruch zwischen Dokumenten erkannt',
    description: row.title,
    type: 'contradiction',
    priority: 'high',
    affectedEntityIds: documents.map(({ id }) => id),
    proposedActions: [{ label: 'Insights öffnen', kind: 'navigate', target: '/insights/' }],
    dedupeKey: `contradiction:${row.id}`,
  });
}
