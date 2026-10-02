import { localDate, type OpenItem } from '@archivist/shared';
import { idsHash, type CheckRun } from './findings';

const OPEN_ITEMS_PAGE = { label: 'Offene Punkte öffnen', kind: 'navigate' as const, target: '/open-items/' };

/** The local calendar day of the run (otherwise items are "due today" for two more hours after midnight, #77) and the stale limit. */
export interface CheckTime {
  today: string;
  staleDays: number;
}

/** One notification listing the open items that lack something; dismissed ones are never revived, so the key keeps the member hash. */
function notifyMissing(run: CheckRun, missing: { items: OpenItem[]; key: string; title: string; type: 'open_item_no_owner' | 'open_item_no_due' }): void {
  const { items } = missing;
  run.findings.notificationKeys.add(missing.key);
  run.deps.notifications.create({
    title: missing.title,
    description: items
      .slice(0, 5)
      .map((item) => item.title)
      .join(', '),
    type: missing.type,
    priority: 'low',
    affectedEntityIds: items.map((item) => item.id),
    proposedActions: [OPEN_ITEMS_PAGE],
    dedupeKey: missing.key,
  });
  run.findings.notifications += 1;
}

function notifyDue(run: CheckRun, request: { item: OpenItem; today: string }): void {
  const { item, today } = request;
  const due = item.dueAt ? localDate(item.dueAt) : null;
  const { findings, deps } = run;
  if (due && due < today) {
    findings.notificationKeys.add(`overdue:${item.id}:${due}`);
    deps.notifications.create({
      title: `Überfällig: ${item.title}`,
      description: `Fällig war der ${due}.`,
      type: 'open_item_overdue',
      priority: 'high',
      affectedEntityIds: [item.id],
      proposedActions: [OPEN_ITEMS_PAGE, { label: 'Morgen erneut', kind: 'snooze' }],
      dedupeKey: `overdue:${item.id}:${due}`,
    });
    findings.notifications += 1;
    findings.count('open_item');
  } else if (due === today) {
    findings.notificationKeys.add(`due:${item.id}:${today}`);
    deps.notifications.create({
      title: `Heute fällig: ${item.title}`,
      description: 'Dieser offene Punkt ist heute fällig.',
      type: 'open_item_due',
      priority: 'high',
      affectedEntityIds: [item.id],
      proposedActions: [OPEN_ITEMS_PAGE],
      dedupeKey: `due:${item.id}:${today}`,
    });
    findings.notifications += 1;
  }
}

function reportStale(run: CheckRun, request: { item: OpenItem; time: CheckTime }): void {
  const { item, time } = request;
  const ageDays = (Date.now() - new Date(item.updatedAt).getTime()) / 86_400_000;
  if (ageDays <= time.staleDays) return;
  run.findings.insightKeys.add(`stale:${item.id}`);
  run.deps.insights.upsert({
    kind: 'open_item',
    title: `Lange unverändert: ${item.title}`,
    explanation: `Dieser offene Punkt wurde seit ${Math.floor(ageDays)} Tagen nicht aktualisiert.`,
    confidence: 0.7,
    affected: [{ type: 'task', id: item.id, label: item.title }],
    dedupeKey: `stale:${item.id}`,
  });
  run.findings.count('open_item');
}

/** A task documented as open and as completed at the same time. */
function checkOpenAndClosed(run: CheckRun): void {
  const comparable = (title: string) => title.toLowerCase().replace(/\s+/g, ' ').trim();
  const all = run.deps.openItems.list();
  for (const open of all.filter((item) => ['open', 'waiting', 'blocked'].includes(item.status))) {
    const twin = all.find((item) => item.id !== open.id && item.status === 'resolved' && comparable(item.title) === comparable(open.title));
    if (!twin) continue;
    const key = `open-closed:${open.id}:${twin.id}`;
    run.findings.insightKeys.add(key);
    run.deps.insights.upsert({
      kind: 'outdated_info',
      title: `Widersprüchlicher Status: ${open.title}`,
      explanation: 'Ein gleichnamiger offener Punkt ist bereits als erledigt dokumentiert, ein weiterer ist noch offen.',
      confidence: 0.6,
      affected: [
        { type: 'task', id: open.id, label: open.title },
        { type: 'task', id: twin.id, label: twin.title },
      ],
      dedupeKey: key,
    });
    run.findings.count('outdated_info');
  }
}

/** Open items without owner or due date, overdue, due today, long unchanged, or open and resolved at once. */
export function checkOpenItems(run: CheckRun, time: CheckTime): void {
  const active = run.deps.openItems.list({ onlyActive: true });
  const noOwner = active.filter((item) => !item.responsiblePersonId && !item.responsibleUnknown);
  if (noOwner.length) {
    const title = `${noOwner.length} offene Punkte ohne Verantwortlichen`;
    notifyMissing(run, { items: noOwner, key: `no-owner:${idsHash(noOwner.map((item) => item.id))}`, title, type: 'open_item_no_owner' });
    run.findings.count('open_item');
  }
  const noDue = active.filter((item) => !item.dueAt && !item.dueUnknown);
  if (noDue.length) {
    const title = `${noDue.length} offene Punkte ohne Fälligkeitsdatum`;
    notifyMissing(run, { items: noDue, key: `no-due:${idsHash(noDue.map((item) => item.id))}`, title, type: 'open_item_no_due' });
  }
  for (const item of active) {
    notifyDue(run, { item, today: time.today });
    reportStale(run, { item, time });
  }
  checkOpenAndClosed(run);
}
