import { DECISION_FIELD_LABELS, type Decision } from '@archivist/shared';
import { truncate } from '../../util/text';
import { decisionDates } from '../decision-dating';
import { ACTIVE_DECISION_STATUSES } from '../decisions';
import { yieldPeriodically, type CheckRun } from './findings';

const isIncomplete = (decision: Decision) =>
  decision.status === 'draft' || (decision.missingFields.length > 0 && decision.status !== 'revoked' && decision.status !== 'superseded');

/** Drafts and decisions with missing details: a hint and a notification each. */
export async function checkIncompleteDecisions(run: CheckRun, decisions: Decision[]): Promise<void> {
  const { deps, findings } = run;
  for (const [i, decision] of decisions.entries()) {
    await yieldPeriodically(i);
    if (!isIncomplete(decision)) continue;
    const key = `incomplete-decision:${decision.id}`;
    findings.insightKeys.add(key);
    findings.notificationKeys.add(key);
    deps.insights.upsert({
      kind: 'incomplete_decision',
      title: `Unvollständige Entscheidung: ${decision.title}`,
      explanation: `Es fehlen Angaben: ${decision.missingFields.map((field) => DECISION_FIELD_LABELS[field]).join(', ') || '–'}. Ergänze sie im Chat oder unter „Entscheidungen“.`,
      confidence: 1,
      affected: [{ type: 'decision', id: decision.id, label: decision.title }],
      dedupeKey: key,
    });
    deps.notifications.create({
      title: 'Unvollständige Entscheidung',
      description: decision.title,
      type: 'incomplete_decision',
      priority: 'normal',
      affectedEntityIds: [decision.id],
      proposedActions: [{ label: 'Entscheidungen öffnen', kind: 'navigate', target: '/decisions/' }],
      dedupeKey: key,
    });
    findings.notifications += 1;
    findings.count('incomplete_decision');
  }
}

function activeByTopic(decisions: Decision[]): Decision[][] {
  const byTopic = new Map<string, Decision[]>();
  for (const decision of decisions.filter((x) => ACTIVE_DECISION_STATUSES.includes(x.status) && x.topicId))
    byTopic.set(decision.topicId!, [...(byTopic.get(decision.topicId!) ?? []), decision]);
  return [...byTopic.values()];
}

/** Two active decisions on the same topic: the older one may be superseded (unless a contradiction covers the pair). */
export function checkSuperseded(run: CheckRun, decisions: Decision[]): void {
  for (const list of activeByTopic(decisions)) {
    if (list.length < 2) continue;
    // only dated decisions (own date or that of a source document): the capture date says nothing about which is newer (#168)
    const dating = decisionDates(run.deps.ctx.database.db, list);
    const dateOf = (decision: Decision) => dating.get(decision.id)?.date ?? '';
    const sorted = list.filter((decision) => dateOf(decision)).sort((a, b) => dateOf(a).localeCompare(dateOf(b)));
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const older = sorted[i]!;
      const newer = sorted[i + 1]!;
      if (dateOf(older).slice(0, 10) === dateOf(newer).slice(0, 10) || run.deps.contradictions.forPair(older.id, newer.id)) continue;
      proposeSupersede(run, { older, newer, newerDate: dateOf(newer).slice(0, 10) });
    }
  }
}

function proposeSupersede(run: CheckRun, pair: { older: Decision; newer: Decision; newerDate: string }): void {
  const { older, newer } = pair;
  const key = `superseded:${older.id}:${newer.id}`;
  run.findings.insightKeys.add(key);
  const affected = [
    { type: 'decision' as const, id: older.id, label: older.title },
    { type: 'decision' as const, id: newer.id, label: newer.title },
  ];
  const shown = run.deps.insights.upsert({
    kind: 'possibly_superseded',
    title: `Möglicherweise überholt: ${older.title}`,
    explanation: `Zum Thema „${older.topicName}“ existiert eine neuere aktive Entscheidung vom ${pair.newerDate}${newer.decidedAt ? '' : ' (laut Quelldokument)'}: ${truncate(newer.decisionText, 160)}`,
    confidence: 0.5,
    affected,
    action: {
      label: 'Als überholt markieren',
      proposal: {
        actionType: 'supersede_decision',
        label: 'Ältere Entscheidung als überholt markieren',
        rationale: `Zum Thema „${older.topicName}“ gibt es eine neuere Entscheidung.`,
        confidence: 0.5,
        affectedEntities: [...affected],
        requiredConfirmation: 'confirm',
        proposedParameters: { oldDecisionId: older.id, newDecisionId: newer.id },
      },
    },
    dedupeKey: key,
  });
  if (shown.status === 'open') run.findings.count('possibly_superseded');
}
