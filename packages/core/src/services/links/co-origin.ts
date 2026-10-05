import { localDate, type EntityType } from '@archivist/shared';
import type { CreatedEntry } from '../../util/origin-scope';
import { truncate } from '../../util/text';
import { isLinked, type LinkDeps } from './entries';

/** Up to this many entries created together are linked pairwise; more are linked in a chain (#272). */
const MAX_PAIRWISE = 6;
/** Tables of the entries that name their source documents in `source_ids`. */
const SOURCE_TABLES = ['decisions', 'open_items', 'events'] as const;

/** The business date of an entry (#278): event date, decision date, document date – never when it was captured or archived. */
const BUSINESS_DATE: Array<{ table: string; column: string; type: EntityType; extra?: string }> = [
  { table: 'events', column: 'occurred_at', type: 'event', extra: 'AND x.duplicate_of_id IS NULL' },
  { table: 'decisions', column: 'decided_at', type: 'decision' },
  { table: 'documents', column: 'document_date', type: 'document', extra: "AND x.status IN ('archived','indexed_only')" },
];
/** Most same-day proposals per entry: every pair on a busy day would grow quadratically. */
const MAX_DATE_PERSON = 3;
/** Confidence of a same-day proposal with one shared person (#278); every further person adds 0.1. */
const DATE_PERSON_BASE = 0.6;
const dayShift = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const germanDay = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}`;

type Pair = [string, string];

/** Every pair for a few entries, a chain in creation order for more. */
const pairsOf = (ids: string[]): Pair[] =>
  ids.length <= MAX_PAIRWISE ? ids.flatMap((a, index) => ids.slice(index + 1).map((b): Pair => [a, b])) : ids.slice(1).map((b, index) => [ids[index]!, b]);

/** Entries that belong together by origin: created together (#272), from one document (#272), same day and person (#278). */
export class CoOriginLinks {
  constructor(private readonly deps: LinkDeps) {}

  private get sqlite() {
    return this.deps.ctx.database.sqlite;
  }

  /** Proposes `related_to` with method `co_origin` between the pairs; already linked and rejected pairs are skipped. */
  private proposeTogether(request: { pairs: Pair[]; evidence: string; sourceIds: string[] }): number {
    let created = 0;
    for (const [a, b] of request.pairs) {
      if (a === b || isLinked(this.sqlite, { a, b })) continue;
      const { evidence, sourceIds } = request;
      const result = this.deps.graph.link(
        { sourceId: a, targetId: b, relationType: 'related_to' },
        { status: 'proposed', confidence: 0.7, method: 'co_origin', evidence, sourceIds },
      );
      if (result?.created) created += 1;
    }
    return created;
  }

  /** Entries created by the same chat message, with the message as evidence; entries removed meanwhile are skipped. */
  linkCreatedTogether(entries: CreatedEntry[], options: { evidence: string; sourceIds?: string[] }): number {
    const ids = [...new Set(entries.map((entry) => entry.id))].filter((id) => this.deps.graph.getEntity(id));
    if (ids.length < 2) return 0;
    return this.proposeTogether({ pairs: pairsOf(ids), evidence: options.evidence, sourceIds: options.sourceIds ?? [] });
  }

  /** A decision, open item or event naming a document as its source, with the other entries from that document. */
  linkSameDocument(entryId: string): number {
    const documentIds = new Set<string>();
    for (const table of SOURCE_TABLES) {
      const rows = this.sqlite.prepare(`SELECT j.value AS doc FROM ${table} r, json_each(r.source_ids) j WHERE r.id = ?`).all(entryId) as Array<{
        doc: string;
      }>;
      for (const row of rows) documentIds.add(row.doc);
    }
    let created = 0;
    for (const documentId of documentIds) {
      const document = this.deps.graph.getEntity(documentId);
      if (document?.type !== 'document') continue;
      const others = this.othersFromDocument({ entryId, documentId });
      created += this.proposeTogether({
        pairs: others.map((other): Pair => [entryId, other]),
        evidence: `Beide stammen aus dem Dokument „${truncate(document.name, 80)}“.`,
        sourceIds: [documentId],
      });
    }
    return created;
  }

  private othersFromDocument(request: { entryId: string; documentId: string }): string[] {
    return SOURCE_TABLES.flatMap(
      (table) =>
        this.sqlite
          .prepare(
            `SELECT r.id FROM ${table} r WHERE r.id <> ? AND EXISTS (SELECT 1 FROM json_each(r.source_ids) j WHERE j.value = ?)${table === 'decisions' ? '' : ' AND r.duplicate_of_id IS NULL'}`,
          )
          .all(request.entryId, request.documentId) as Array<{ id: string }>,
    ).map((row) => row.id);
  }

  /** Local day of the entry's business date, or null (#278). */
  private businessDay(id: string): string | null {
    for (const source of BUSINESS_DATE) {
      const row = this.sqlite.prepare(`SELECT x.${source.column} AS d FROM ${source.table} x WHERE x.id = ? ${source.extra ?? ''}`).get(id) as
        { d: string | null } | undefined;
      if (row) return row.d ? localDate(row.d) : null;
    }
    return null;
  }

  /** Persons connected to the entry by a current relation – without the user's own person. */
  private personsOf(id: string): Map<string, string> {
    const rows = this.sqlite
      .prepare(
        `SELECT p.id, p.name FROM relations r JOIN entities p ON p.id = CASE WHEN r.source_entity_id = ? THEN r.target_entity_id ELSE r.source_entity_id END
         WHERE (r.source_entity_id = ? OR r.target_entity_id = ?) AND r.status IN ('proposed','confirmed') AND p.type = 'person' AND p.is_self = 0`,
      )
      .all(id, id, id) as Array<{ id: string; name: string }>;
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  /** Events, decisions and documents of the same local day sharing a person (not the user's own) are proposed as `date_person`. */
  proposeSameDayPerson(id: string): number {
    const day = this.businessDay(id);
    if (!day) return 0;
    const persons = this.personsOf(id);
    if (!persons.size) return 0;
    // more shared persons, more confidence; the learned raise (#275) holds back the weakest ones first
    const bar = DATE_PERSON_BASE + (this.deps.thresholds?.offset('date_person') ?? 0) - 1e-9;
    const found: Array<{ otherId: string; confidence: number; evidence: string }> = [];
    for (const otherId of this.sameDayEntries({ id, day })) {
      const shared = [...this.personsOf(otherId).entries()].filter(([personId]) => persons.has(personId)).map(([, name]) => `„${name}“`);
      const confidence = Math.min(0.8, DATE_PERSON_BASE + 0.1 * (shared.length - 1));
      if (!shared.length || confidence < bar) continue;
      found.push({ otherId, confidence, evidence: `Am ${germanDay(day)} mit ${shared.join(', ')}` });
    }
    let created = 0;
    for (const { otherId, confidence, evidence } of found.toSorted((a, b) => b.confidence - a.confidence).slice(0, MAX_DATE_PERSON)) {
      const result = this.deps.graph.link(
        { sourceId: id, targetId: otherId, relationType: 'related_to' },
        { status: 'proposed', confidence, method: 'date_person', evidence },
      );
      if (result?.created) created += 1;
    }
    return created;
  }

  /** Other entries on the same local day that are not linked with the entry yet. */
  private *sameDayEntries(entry: { id: string; day: string }): Generator<string> {
    for (const source of BUSINESS_DATE) {
      // stored instants can fall on a neighbouring UTC day: take one day around and compare the local day
      const rows = this.sqlite
        .prepare(
          `SELECT x.id, x.${source.column} AS d FROM ${source.table} x WHERE x.id <> ? AND substr(x.${source.column}, 1, 10) BETWEEN ? AND ? ${source.extra ?? ''}`,
        )
        .all(entry.id, dayShift(entry.day, -1), dayShift(entry.day, 1)) as Array<{ id: string; d: string }>;
      for (const row of rows) {
        if (localDate(row.d) !== entry.day || isLinked(this.sqlite, { a: entry.id, b: row.id }) || !this.deps.graph.getEntity(row.id)) continue;
        yield row.id;
      }
    }
  }
}
