import { truncate } from '../../util/text';
import { lower, type ToolDeps } from './common';

export const ENTRY_KINDS = ['decision', 'open_item', 'reminder', 'event', 'note', 'proposal', 'insight', 'case'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export interface EntryArgs {
  kind: EntryKind;
  status: string | null;
  topic: string | null;
  project: string | null;
  query: string | null;
  from: string | null;
  to: string | null;
}

export interface EntryRow {
  id: string;
  text: string;
  date: string;
}

/** A row of an entry derived from documents: hidden when all of them are hidden. */
interface SourcedRow extends EntryRow {
  sourceIds?: string[];
  kindLabel?: string;
}

/** The filters of a `list_entries` call as predicates. */
interface EntryFilter {
  args: EntryArgs;
  matches: (...values: Array<string | null | undefined>) => boolean;
  inRange: (date: string | null | undefined) => boolean;
  inSubject: (topicName: string | null | undefined, projectName: string | null | undefined) => boolean;
}

const decisionRows = (deps: ToolDeps, { args, matches, inRange, inSubject }: EntryFilter): SourcedRow[] =>
  deps.decisions
    .list(args.status ? { status: args.status as never } : {})
    .filter((d) => matches(d.title, d.decisionText) && inSubject(d.topicName, d.projectName) && inRange(d.decidedAt))
    .map((d) => ({
      id: d.id,
      sourceIds: d.sourceIds,
      kindLabel: 'Entscheidung',
      date: d.decidedAt ?? d.createdAt,
      text: `Entscheidung „${truncate(d.title, 90)}“ [${d.status}] ${d.decidedAt?.slice(0, 10) ?? 'ohne Datum'}${d.topicName ? ` | Thema: ${d.topicName}` : ''}${d.projectName ? ` | Projekt: ${d.projectName}` : ''}${d.missingFields.length ? ` | fehlt: ${d.missingFields.join(', ')}` : ''} – ${truncate(d.decisionText.replace(/\s+/g, ' '), 160)}`,
    }));

const openItemRows = (deps: ToolDeps, { args, matches, inRange, inSubject }: EntryFilter): SourcedRow[] =>
  deps.openItems
    .list(args.status ? { status: args.status as never } : { onlyActive: true })
    .filter((o) => matches(o.title, o.description) && inSubject(o.topicName, o.projectName) && inRange(o.dueAt ?? o.createdAt))
    .map((o) => ({
      id: o.id,
      sourceIds: o.sourceIds,
      kindLabel: 'offener Punkt',
      date: o.dueAt ?? o.createdAt,
      text: `offener Punkt „${truncate(o.title, 90)}“ [${o.status}]${o.dueAt ? ` fällig ${o.dueAt.slice(0, 10)}` : ''}${o.responsibleName ? ` | verantwortlich: ${o.responsibleName}` : ''}${o.reminderAt ? ` | Erinnerung ${o.reminderAt.slice(0, 16)}` : ''}`,
    }));

const reminderRows = (deps: ToolDeps, { args, matches, inRange }: EntryFilter): SourcedRow[] =>
  deps.reminders
    .list((args.status as 'pending') ?? 'pending')
    .filter((r) => matches(r.title) && inRange(r.remindAt))
    .map((r) => ({
      id: r.id,
      date: r.remindAt,
      text: `Erinnerung „${truncate(r.title, 90)}“ am ${r.remindAt.slice(0, 16)} [${r.status}]${r.targetType !== 'custom' ? ` zu ${r.targetType}` : ''}`,
    }));

const eventRows = (deps: ToolDeps, { matches, inRange, inSubject }: EntryFilter): SourcedRow[] =>
  deps.events
    .list()
    .filter((e) => !e.duplicateOfId && matches(e.title, e.description) && inSubject(e.topicName, e.projectName) && inRange(e.occurredAt))
    .map((e) => ({
      id: e.id,
      sourceIds: e.sourceIds,
      kindLabel: 'Ereignis',
      date: e.occurredAt,
      text: `Ereignis am ${e.occurredAt.slice(0, 10)}: ${truncate(e.title, 90)}${e.description ? ` – ${truncate(e.description, 120)}` : ''}`,
    }));

const noteRows = (deps: ToolDeps, { matches, inRange }: EntryFilter): SourcedRow[] =>
  deps.graph
    .listEntities({ type: 'note', limit: 1000 })
    .filter((n) => !n.duplicateOfId && matches(n.name, n.description) && inRange(n.createdAt))
    .map((n) => ({
      id: n.id,
      date: n.createdAt,
      text: `Notiz vom ${n.createdAt.slice(0, 10)}: ${truncate((n.description ?? n.name).replace(/\s+/g, ' '), 200)}`,
    }));

const proposalRows = (deps: ToolDeps, { matches }: EntryFilter): SourcedRow[] =>
  deps.actions
    .list('proposed')
    .filter((p) => matches(p.label, p.rationale))
    .map((p) => ({ id: p.id, date: p.createdAt, text: `Vorschlag „${truncate(p.label, 100)}“ (${p.actionType}) – ${truncate(p.rationale, 140)}` }));

const insightRows = (deps: ToolDeps, { args, matches }: EntryFilter): SourcedRow[] =>
  deps.insights
    .list({ status: (args.status as 'open') ?? 'open' })
    .filter((i) => matches(i.title, i.explanation))
    .map((i) => ({ id: i.id, date: i.createdAt, text: `Hinweis „${truncate(i.title, 100)}“ (${i.kind}) – ${truncate(i.explanation, 160)}` }));

const caseRows = (deps: ToolDeps, { args, matches }: EntryFilter): SourcedRow[] =>
  deps.graph
    .listEntities({ type: 'case', limit: 500 })
    .filter((c) => matches(c.name, c.description) && (!args.status || c.status === args.status))
    .map((c) => ({ id: c.id, date: c.createdAt, text: `Vorgang „${c.name}“ [${c.status ?? 'open'}] – ${c.relationCount} Einträge` }));

const ROWS_OF: Record<EntryKind, (deps: ToolDeps, filter: EntryFilter) => SourcedRow[]> = {
  decision: decisionRows,
  open_item: openItemRows,
  reminder: reminderRows,
  event: eventRows,
  note: noteRows,
  proposal: proposalRows,
  insight: insightRows,
  case: caseRows,
};

function entryFilter(args: EntryArgs): EntryFilter {
  const query = args.query?.toLowerCase() ?? null;
  return {
    args,
    matches: (...values) => !query || values.some((v) => lower(v).includes(query)),
    inRange: (date) => (!args.from || (date ?? '') >= args.from) && (!args.to || (date ?? '9999') <= args.to),
    inSubject: (topicName, projectName) =>
      (!args.topic || lower(topicName).includes(args.topic.toLowerCase())) && (!args.project || lower(projectName).includes(args.project.toLowerCase())),
  };
}

/** An entry known only from documents that may not be shared is not described to the model either (#301). */
function fromHiddenOnly(deps: ToolDeps, sourceIds: readonly string[]): boolean {
  if (!sourceIds.length) return false;
  return sourceIds.every((id) => {
    const row = deps.docs.findRow(id);
    return row !== undefined && !deps.privacy.mayShareDocument(deps.docs.get(id));
  });
}

const HIDDEN_ENTRY = '[nicht freigegeben – stammt aus einem nicht freigegebenen Dokument]';

export function entryRows(deps: ToolDeps, args: EntryArgs): EntryRow[] {
  const rows = ROWS_OF[args.kind](deps, entryFilter(args));
  return rows.map((r) => (r.sourceIds && fromHiddenOnly(deps, r.sourceIds) ? { id: r.id, date: r.date, text: `${r.kindLabel} ${HIDDEN_ENTRY}` } : r));
}
