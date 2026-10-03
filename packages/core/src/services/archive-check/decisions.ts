import { DECISION_FIELD_LABELS, type Decision } from '@archivist/shared';
import { normalizeName, truncate } from '../../util/text';
import { sharesContent } from '../contradiction-rules';
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

/** Active decisions grouped by topic, or by project when they have no topic. */
function activeByScope(decisions: Decision[]): Decision[][] {
  const groups = new Map<string, Decision[]>();
  for (const decision of decisions.filter((x) => ACTIVE_DECISION_STATUSES.includes(x.status))) {
    const key = decision.topicId ? `topic:${decision.topicId}` : decision.projectId ? `project:${decision.projectId}` : null;
    if (key) groups.set(key, [...(groups.get(key) ?? []), decision]);
  }
  return [...groups.values()];
}

type DateOf = (decision: Decision) => string;
const dayOf = (dateOf: DateOf, decision: Decision) => dateOf(decision).slice(0, 10);

/** Active decisions with identical text and the same (or no) date: the later captured one is probably a duplicate of the earlier one. */
function checkDuplicates(run: CheckRun, { list, dateOf }: { list: Decision[]; dateOf: DateOf }): void {
  const buckets = new Map<string, Decision[]>();
  for (const decision of list) {
    const key = `${normalizeName(decision.decisionText)}|${dayOf(dateOf, decision)}`;
    buckets.set(key, [...(buckets.get(key) ?? []), decision]);
  }
  for (const bucket of buckets.values()) {
    const byCapture = bucket.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (let i = 0; i < byCapture.length - 1; i += 1) {
      const [older, newer] = [byCapture[i]!, byCapture[i + 1]!];
      proposeSupersede(run, {
        older,
        newer,
        title: `Doppelte Entscheidung: ${newer.title}`,
        explanation: `Zu „${scopeName(older)}“ gibt es dieselbe Entscheidung zweimal: ${truncate(newer.decisionText, 160)}`,
        rationale: 'Die beiden Entscheidungen sind inhaltlich gleich.',
      });
    }
  }
}

const scopeName = (decision: Decision) => decision.topicName ?? decision.projectName ?? 'diesem Thema';

/** Two active decisions on the same topic or project that speak about the same thing: the older one may be superseded (unless a contradiction covers the pair). */
export function checkSuperseded(run: CheckRun, decisions: Decision[]): void {
  for (const list of activeByScope(decisions)) {
    if (list.length < 2) continue;
    // only dated decisions (own date or that of a source document): the capture date says nothing about which is newer (#168)
    const dating = decisionDates(run.deps.ctx.database.db, list);
    const dateOf: DateOf = (decision) => dating.get(decision.id)?.date ?? '';
    checkDuplicates(run, { list, dateOf });
    const sorted = list.filter((decision) => dateOf(decision)).sort((a, b) => dateOf(a).localeCompare(dateOf(b)));
    for (const [index, newer] of sorted.entries()) {
      const older = sorted
        .slice(0, index)
        .findLast((candidate) => dayOf(dateOf, candidate) !== dayOf(dateOf, newer) && sharesContent(candidate.decisionText, newer.decisionText));
      if (!older || run.deps.contradictions.forPair(older.id, newer.id)) continue;
      const newerDate = dayOf(dateOf, newer);
      proposeSupersede(run, {
        older,
        newer,
        title: `Möglicherweise überholt: ${older.title}`,
        explanation: `Zum Thema „${scopeName(older)}“ existiert eine neuere aktive Entscheidung vom ${newerDate}${newer.decidedAt ? '' : ' (laut Quelldokument)'}: ${truncate(newer.decisionText, 160)}`,
        rationale: `Zum Thema „${scopeName(older)}“ gibt es eine neuere Entscheidung.`,
      });
    }
  }
}

function proposeSupersede(run: CheckRun, pair: { older: Decision; newer: Decision; title: string; explanation: string; rationale: string }): void {
  const { older, newer } = pair;
  const key = `superseded:${older.id}:${newer.id}`;
  run.findings.insightKeys.add(key);
  const affected = [
    { type: 'decision' as const, id: older.id, label: older.title },
    { type: 'decision' as const, id: newer.id, label: newer.title },
  ];
  const shown = run.deps.insights.upsert({
    kind: 'possibly_superseded',
    title: pair.title,
    explanation: pair.explanation,
    confidence: 0.5,
    affected,
    action: {
      label: 'Als überholt markieren',
      proposal: {
        actionType: 'supersede_decision',
        label: 'Ältere Entscheidung als überholt markieren',
        rationale: pair.rationale,
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

/** Active decisions whose validity ended before today: the user checks whether they still hold. */
export function checkExpiredDecisions(run: CheckRun, { decisions, today }: { decisions: Decision[]; today: string }): void {
  for (const decision of decisions.filter((x) => ACTIVE_DECISION_STATUSES.includes(x.status) && x.validUntil && x.validUntil.slice(0, 10) < today)) {
    const key = `expired-decision:${decision.id}`;
    run.findings.insightKeys.add(key);
    const shown = run.deps.insights.upsert({
      kind: 'decision_expired',
      title: `Gültigkeit abgelaufen: ${decision.title}`,
      explanation: `Die Entscheidung galt bis ${decision.validUntil!.slice(0, 10)}. Prüfe, ob sie noch gilt, verlängere ihre Gültigkeit oder widerrufe sie unter „Entscheidungen“.`,
      confidence: 1,
      affected: [{ type: 'decision', id: decision.id, label: decision.title }],
      dedupeKey: key,
    });
    if (shown.status === 'open') run.findings.count('decision_expired');
  }
}
