import { localDate, type EntityRef, type TimelineEntry } from '@archivist/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context';
import type { Db } from '../db/database';
import { contradictions, decisions, documents, entities, events, openItems, relations } from '../db/schema';
import { withSubject } from '../db/subject-filter';
import { truncate } from '../util/text';
import { decisionDates } from './decision-dating';

export interface TimelineQuery {
  topicId?: string;
  projectId?: string;
  from?: string;
  to?: string;
  /** Maximum number of entries; the newest ones are kept (default 300). */
  limit?: number;
}

type UndatedEntry = Omit<TimelineEntry, 'year'>;
type SubjectMatch = (row: { id: string; topicId: string | null; projectId: string | null }) => boolean;
type RefsOf = (type: EntityRef['type'], id: string | null) => EntityRef[];
type EntityName = (id: string) => string | null;

/** The database handle with the lookups shared by the entry builders. */
interface TimelineReader {
  db: Db;
  match: SubjectMatch;
  refsOf: RefsOf;
  entityName: EntityName;
}

/** Chronological view of documents, decisions, open items and contradictions; the newest `limit` entries, oldest first. */
export class TimelineService {
  constructor(private readonly ctx: AppContext) {}

  get(q: TimelineQuery = {}): TimelineEntry[] {
    return buildTimeline(this.ctx.database.db, q);
  }
}

/** A topic or project with its subtopics (#282). */
function subjectTree(db: Db, subjectId: string | undefined): Set<string> {
  if (!subjectId) return new Set();
  const tree = [subjectId];
  for (let i = 0; i < tree.length && tree.length < 1000; i += 1)
    for (const row of db
      .select({ id: relations.sourceEntityId })
      .from(relations)
      .where(and(eq(relations.targetEntityId, tree[i]!), eq(relations.relationType, 'subtopic_of'), eq(relations.status, 'confirmed')))
      .all())
      if (!tree.includes(row.id)) tree.push(row.id);
  return new Set(tree);
}

/** Entries with a confirmed relation to one of the subjects (a further topic/project, #287). */
function furtherEntries(db: Db, subjects: Set<string>): Set<string> {
  if (!subjects.size) return new Set();
  return new Set(
    db
      .select({ id: relations.sourceEntityId })
      .from(relations)
      .where(and(inArray(relations.targetEntityId, [...subjects]), eq(relations.status, 'confirmed')))
      .all()
      .map((row) => row.id),
  );
}

function subjectFilter(db: Db, subjectId: string | undefined): (mainId: string | null, entryId: string) => boolean {
  if (!subjectId) return () => true;
  const tree = subjectTree(db, subjectId);
  const further = furtherEntries(db, tree);
  return (mainId, entryId) => Boolean(mainId && tree.has(mainId)) || further.has(entryId);
}

function subjectMatcher(db: Db, q: TimelineQuery): SubjectMatch {
  const topic = subjectFilter(db, q.topicId);
  const project = subjectFilter(db, q.projectId);
  return (row) => topic(row.topicId, row.id) && project(row.projectId, row.id);
}

function entityNames(db: Db): EntityName {
  const names = new Map<string, string | null>();
  return (id) => {
    if (!names.has(id)) names.set(id, db.select({ name: entities.name }).from(entities).where(eq(entities.id, id)).get()?.name ?? null);
    return names.get(id) ?? null;
  };
}

/** Timestamps belong to the local day, not the UTC day (#77); an undated entry is only shown without a date range. */
function inRange(entry: UndatedEntry, q: TimelineQuery): TimelineEntry[] {
  const date = localDate(entry.date);
  if (entry.undated && (q.from || q.to)) return [];
  if (q.from && date < localDate(q.from)) return [];
  if (q.to && date > localDate(q.to)) return [];
  return [{ ...entry, date, year: Number(date.slice(0, 4)) || 0 }];
}

function subjectRefs(refsOf: RefsOf, row: { topicId: string | null; projectId: string | null }): EntityRef[] {
  return [...refsOf('topic', row.topicId), ...refsOf('project', row.projectId)];
}

/** Filtered in the database and without the extracted text – SELECT * loaded every full text per call (#214). */
function documentEntries({ db, refsOf }: TimelineReader, q: TimelineQuery): UndatedEntry[] {
  const rows = db
    .select({
      id: documents.id,
      title: documents.title,
      summary: documents.summary,
      topicId: documents.topicId,
      projectId: documents.projectId,
      documentDate: documents.documentDate,
      dates: documents.dates,
      archivedAt: documents.archivedAt,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .where(
      and(
        inArray(documents.status, ['archived', 'indexed_only']),
        q.topicId ? withSubject({ idCol: documents.id, mainCol: documents.topicId, subjectId: q.topicId }) : undefined,
        q.projectId ? withSubject({ idCol: documents.id, mainCol: documents.projectId, subjectId: q.projectId }) : undefined,
      ),
    )
    .all();
  return rows.map((row) => ({
    id: `doc:${row.id}`,
    date: row.documentDate ?? row.dates[0] ?? row.archivedAt ?? row.createdAt,
    kind: 'document',
    title: `Dokument: ${row.title}`,
    description: row.summary ? truncate(row.summary, 220) : null,
    refs: [{ type: 'document', id: row.id, label: row.title }, ...subjectRefs(refsOf, row)],
  }));
}

const DECISION_STATUS_NOTE: Record<string, string> = { superseded: ' (überholt)', draft: ' (Entwurf)', revoked: ' (widerrufen)', unclear: ' (unklar)' };

/** Without a decision or source document date a decision is undated; its capture day only keeps it in order (#168). */
function decisionEntries({ db, refsOf }: TimelineReader, rows: Array<typeof decisions.$inferSelect>): UndatedEntry[] {
  const dating = decisionDates(db, rows);
  return rows.map((row) => {
    const dated = dating.get(row.id);
    const dateNote = dated?.basis === 'source' ? ' (Datum laut Quelldokument)' : '';
    return {
      id: `dec:${row.id}`,
      date: dated?.date ?? row.createdAt,
      kind: 'decision',
      title: `Entscheidung${DECISION_STATUS_NOTE[row.status] ?? ''}${dateNote}: ${row.title}`,
      description: truncate(row.decisionText, 240),
      refs: [{ type: 'decision', id: row.id, label: row.title }, ...subjectRefs(refsOf, row)],
      ...(dated?.date ? {} : { undated: true }),
    };
  });
}

/** A discarded duplicate event is represented by the event it was merged into. */
function eventEntries({ db, match, refsOf }: TimelineReader): UndatedEntry[] {
  return db
    .select()
    .from(events)
    .all()
    .filter((row) => !row.duplicateOfId && match(row))
    .map((row) => ({
      id: `event:${row.id}`,
      date: row.occurredAt,
      kind: 'event',
      title: `Ereignis: ${row.title}`,
      description: row.description ? truncate(row.description, 240) : null,
      refs: [{ type: 'event', id: row.id, label: row.title }, ...subjectRefs(refsOf, row)],
    }));
}

function openItemEntries(row: typeof openItems.$inferSelect, refsOf: RefsOf): UndatedEntry[] {
  const refs: EntityRef[] = [{ type: 'task', id: row.id, label: row.title }, ...subjectRefs(refsOf, row)];
  const out: UndatedEntry[] = [
    {
      id: `task:${row.id}:created`,
      date: row.createdAt,
      kind: 'open_item',
      title: `Offener Punkt angelegt: ${row.title}`,
      description: row.description ? truncate(row.description, 200) : null,
      refs,
    },
  ];
  if (row.dueAt)
    out.push({ id: `task:${row.id}:due`, date: row.dueAt, kind: 'open_item', title: `Fällig: ${row.title}`, description: `Status: ${row.status}`, refs });
  if (row.status === 'resolved' || row.status === 'dismissed')
    out.push({
      id: `task:${row.id}:done`,
      date: row.updatedAt,
      kind: 'open_item',
      title: `${row.status === 'resolved' ? 'Erledigt' : 'Verworfen'}: ${row.title}`,
      description: row.resolutionNote ? truncate(row.resolutionNote, 240) : null,
      refs,
    });
  return out;
}

/** Without a subject filter every contradiction, else those affecting the shown decisions; the contradiction's ref comes first. */
function contradictionEntries({ db, entityName }: TimelineReader, affecting: Set<string> | 'all'): UndatedEntry[] {
  return db
    .select()
    .from(contradictions)
    .all()
    .filter((row) => affecting === 'all' || row.affectedEntityIds.some((id) => affecting.has(id)))
    .map((row) => ({
      id: `contra:${row.id}`,
      date: row.createdAt,
      kind: 'contradiction',
      title: row.title,
      description: truncate(row.description, 240),
      refs: [
        { type: 'contradiction', id: row.id, label: row.title },
        ...row.affectedEntityIds.map((id) => ({
          type: row.dedupeKey.startsWith('document:') ? ('document' as const) : ('decision' as const),
          id,
          label: entityName(id) ?? id,
        })),
      ],
    }));
}

/** The timeline as a pure read over a database handle – on the main connection or the read worker's own one (#215). */
export function buildTimeline(db: Db, q: TimelineQuery = {}): TimelineEntry[] {
  const match = subjectMatcher(db, q);
  const entityName = entityNames(db);
  const refsOf: RefsOf = (type, id) => (id ? [{ type, id, label: entityName(id) ?? id }] : []);
  const reader: TimelineReader = { db, match, refsOf, entityName };
  const decisionRows = db.select().from(decisions).all().filter(match);
  const filtered = Boolean(q.topicId || q.projectId);
  const entries = [
    ...documentEntries(reader, q),
    ...decisionEntries(reader, decisionRows),
    ...eventEntries(reader),
    ...db
      .select()
      .from(openItems)
      .all()
      .filter(match)
      .flatMap((row) => openItemEntries(row, refsOf)),
    ...contradictionEntries(reader, filtered ? new Set(decisionRows.map((row) => row.id)) : 'all'),
  ].flatMap((entry) => inRange(entry, q));
  // filter first, then keep the NEWEST `limit` entries in chronological order
  const sorted = entries.toSorted((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const limit = q.limit ?? 300;
  return sorted.length > limit ? sorted.slice(sorted.length - limit) : sorted;
}
