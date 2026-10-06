import type { EntityType } from '@archivist/shared';
import { eq, or, sql, type SQL } from 'drizzle-orm';
import type { AppContext } from '../../context';
import type { Db } from '../../db/database';
import { entities, relations } from '../../db/schema';
import { AppError } from '../../util/errors';
import { nowIso } from '../../util/ids';
import { normalizeName } from '../../util/text';
import type { AuditService } from '../audit';
import type { UndoService } from '../undo';
import { blockNames, unblockNames } from './blocked-names';
import type { NodeSnapshot } from './entities';
import { REF_TABLES, REF_TABLE_NAMES, TOPIC_OR_PROJECT, column, fingerprints, refTable, selection } from './merge-references';
import { emptyRefSets, type MergeReindexer, type RefRow, type RefSets, type RefTableName } from './merge-types';
import { entityRow, otherEndOf, relationRowsOf, type EntityRow } from './rows';

/** Audit undo type of a deleted subject. */
export const SUBJECT_DELETE_UNDO_TYPE = 'entity.delete';

/** Named subjects the user can delete; records (decisions, notes …) have their own delete. */
export const DELETABLE_SUBJECT_TYPES = new Set<string>(['person', 'topic', 'project', 'tag']);

const CHANGED_SCOPES = ['knowledge', 'documents', 'decisions', 'openItems', 'events'] as const;
const ACTIVE_RELATION = new Set(['proposed', 'confirmed']);

/** A record that names the subject and loses that reference with the deletion. */
export interface SubjectRecordUse {
  table: RefTableName;
  id: string;
  title: string;
  /** The subject was the record's main topic/project, which the filing follows. */
  main: boolean;
}

export interface SubjectImpact {
  id: string;
  type: EntityType;
  name: string;
  /** Relations to other entries (proposed or confirmed). */
  relations: number;
  records: SubjectRecordUse[];
}

/** What a deletion removes, in total: 0 means the subject hangs on nothing. */
export const linkCount = (impact: SubjectImpact): number => impact.relations + impact.records.length;

export interface SubjectDeleteResult {
  auditId: string;
  impact: SubjectImpact;
  /** Every relation removed, rejected ones included. */
  relationsRemoved: number;
}

interface RecordChange {
  table: RefTableName;
  row: RefRow;
  next: RefRow;
  columns: string[];
}

interface DeleteUndoData {
  snapshot: NodeSnapshot;
  refs: Array<{ table: RefTableName; id: string; before: RefRow }>;
  blockedIds: string[];
  /** Fingerprints of the changed records right after the deletion; any difference blocks the undo. */
  after: Record<string, string | null>;
}

interface Subject {
  entity: EntityRow;
  names: Set<string>;
  listColumn: string | undefined;
  responsible: boolean;
  mainSlots: boolean;
}

function subjectOf(entity: EntityRow, table: RefTableName): Subject {
  const spec = REF_TABLES[table];
  return {
    entity,
    names: new Set([entity.normalizedName, ...entity.aliases.map(normalizeName)]),
    listColumn: spec.lists[entity.type as EntityType],
    responsible: spec.responsible === true && entity.type === 'person',
    mainSlots: TOPIC_OR_PROJECT.has(entity.type),
  };
}

/** The record as it is left without the subject (pure). */
function withoutSubject(row: RefRow, subject: Subject): RefRow {
  const next: RefRow = { ...row };
  if (subject.mainSlots) for (const slot of ['topicId', 'projectId']) if (next[slot] === subject.entity.id) next[slot] = null;
  if (subject.responsible && next.responsiblePersonId === subject.entity.id) next.responsiblePersonId = null;
  if (subject.listColumn) next[subject.listColumn] = (next[subject.listColumn] as string[]).filter((name) => !subject.names.has(normalizeName(name)));
  return next;
}

function conditionsOf(table: RefTableName, subject: Subject): SQL[] {
  const shape = refTable(table);
  const conditions: SQL[] = [];
  if (subject.mainSlots) conditions.push(eq(shape.topicId, subject.entity.id), eq(shape.projectId, subject.entity.id));
  if (subject.responsible) conditions.push(eq(column(shape, 'responsiblePersonId'), subject.entity.id));
  if (subject.listColumn) conditions.push(sql`${column(shape, subject.listColumn)} != '[]'`);
  return conditions;
}

/** Documents, decisions, open items and events that reference the subject by id or by name. */
function recordChanges(db: Db, entity: EntityRow): RecordChange[] {
  return REF_TABLE_NAMES.flatMap((table) => {
    const subject = subjectOf(entity, table);
    const conditions = conditionsOf(table, subject);
    if (conditions.length === 0) return [];
    const shape = refTable(table);
    const rows = db
      .select(selection(shape, ['id', 'title', ...REF_TABLES[table].columns]))
      .from(shape)
      .where(or(...conditions))
      .all() as RefRow[];
    return rows.flatMap((row) => {
      const next = withoutSubject(row, subject);
      const columns = REF_TABLES[table].columns.filter((name) => name !== 'updatedAt' && JSON.stringify(next[name]) !== JSON.stringify(row[name]));
      return columns.length ? [{ table, row, next, columns }] : [];
    });
  });
}

const isMain = (change: RecordChange) => change.columns.some((name) => name === 'topicId' || name === 'projectId');

function impactOf(db: Db, entity: EntityRow): SubjectImpact {
  return {
    id: entity.id,
    type: entity.type as EntityType,
    name: entity.name,
    relations: relationRowsOf(db, entity.id).filter((relation) => ACTIVE_RELATION.has(relation.status)).length,
    records: recordChanges(db, entity).map((change) => ({
      table: change.table,
      id: String(change.row.id),
      title: String(change.row.title),
      main: isMain(change),
    })),
  };
}

export type SubjectDeletionDeps = { ctx: AppContext; audit: AuditService; undo: UndoService; snapshots: { snapshot: (id: string) => NodeSnapshot | null } };

/** Deleting a named subject (person, topic, project, tag) with all its edges; the name stays blocked for the analysis; exact undo. */
export class SubjectDeletion {
  private reindexer: MergeReindexer = async () => {};

  private readonly ctx: AppContext;
  private readonly audit: AuditService;
  private readonly snapshots: SubjectDeletionDeps['snapshots'];

  constructor(deps: SubjectDeletionDeps) {
    ({ ctx: this.ctx, audit: this.audit, snapshots: this.snapshots } = deps);
    deps.undo.register(SUBJECT_DELETE_UNDO_TYPE, {
      check: async (data) => this.conflicts(data as DeleteUndoData),
      run: (data) => this.restore(data as DeleteUndoData),
    });
  }

  private get db() {
    return this.ctx.database.db;
  }

  setReindexer(reindexer: MergeReindexer): void {
    this.reindexer = reindexer;
  }

  /** What deleting the subject would remove; throws for the user's own person and for entries that are no named subject. */
  impact(id: string): SubjectImpact {
    return impactOf(this.db, this.deletable(id));
  }

  async delete(id: string, options: { actor: 'user' | 'agent'; trigger: string; reason?: string }): Promise<SubjectDeleteResult> {
    const entity = this.deletable(id);
    const changes = recordChanges(this.db, entity);
    const impact = impactOf(this.db, entity);
    const snapshot = this.snapshots.snapshot(id);
    if (!snapshot) throw new AppError('validation_error', 'Eintrag nicht gefunden.');
    const reindex = emptyRefSets();
    const now = nowIso();
    const auditId = this.ctx.database.transaction(() => {
      const refs = changes.map((change) => this.clear(change, now));
      for (const ref of refs) reindex[ref.table].add(ref.id);
      this.db
        .delete(relations)
        .where(or(eq(relations.sourceEntityId, id), eq(relations.targetEntityId, id)))
        .run();
      this.db.delete(entities).where(eq(entities.id, id)).run();
      const blockedIds = blockNames(this.db, { type: entity.type as EntityType, names: [entity.name, ...entity.aliases] });
      const data: DeleteUndoData = {
        snapshot,
        refs,
        blockedIds,
        after: fingerprints(
          this.db,
          refs.map((ref) => `${ref.table}:${ref.id}`),
        ),
      };
      return this.audit.log({
        action: SUBJECT_DELETE_UNDO_TYPE,
        actor: options.actor,
        trigger: options.trigger,
        confirmed: true,
        entityIds: [id],
        before: { type: entity.type, name: entity.name, reason: options.reason ?? null },
        after: { relationsRemoved: snapshot.relations.length, recordsChanged: refs.length },
        undo: { type: SUBJECT_DELETE_UNDO_TYPE, data },
      });
    });
    this.ctx.events.changed(...CHANGED_SCOPES);
    await this.runReindex(reindex);
    return { auditId, impact, relationsRemoved: snapshot.relations.length };
  }

  private deletable(id: string): EntityRow {
    const entity = entityRow(this.db, id);
    if (!entity) throw new AppError('validation_error', 'Eintrag nicht gefunden.');
    if (entity.isSelf) throw new AppError('validation_error', 'Du selbst kannst nicht gelöscht werden.');
    if (!DELETABLE_SUBJECT_TYPES.has(entity.type))
      throw new AppError('validation_error', `„${entity.name}“ ist keine Person, kein Thema, Projekt oder Schlagwort.`);
    return entity;
  }

  private clear(change: RecordChange, now: string): DeleteUndoData['refs'][number] {
    const id = String(change.row.id);
    const before: RefRow = { updatedAt: change.row.updatedAt ?? null };
    const set: RefRow = { updatedAt: now };
    for (const name of change.columns) {
      before[name] = change.row[name] ?? null;
      set[name] = change.next[name] ?? null;
    }
    const shape = refTable(change.table);
    this.db.update(shape).set(set).where(eq(shape.id, id)).run();
    return { table: change.table, id, before };
  }

  private conflicts(data: DeleteUndoData): string[] {
    const { node } = data.snapshot;
    const out: string[] = [];
    if (entityRow(this.db, node.id)) out.push(`„${node.name}“ ist bereits wiederhergestellt.`);
    const recreated = this.db.select().from(entities).where(eq(entities.normalizedName, node.normalizedName)).all();
    if (recreated.some((entity) => entity.type === node.type && entity.id !== node.id))
      out.push(`„${node.name}“ wurde seit dem Löschen neu angelegt. Bitte zuerst diesen Eintrag bereinigen.`);
    const changed = Object.entries(data.after).some(([key, expected]) => fingerprints(this.db, [key])[key] !== expected);
    if (changed) out.push('Ein betroffener Eintrag wurde seit dem Löschen verändert.');
    return out;
  }

  private async restore(data: DeleteUndoData): Promise<string> {
    const { snapshot } = data;
    const reindex = emptyRefSets();
    let skipped = 0;
    this.ctx.database.transaction(() => {
      this.db.insert(entities).values(snapshot.node).run();
      for (const relation of snapshot.relations) {
        if (!entityRow(this.db, otherEndOf(relation, snapshot.node.id))) skipped += 1;
        else this.db.insert(relations).values(relation).onConflictDoNothing().run();
      }
      for (const ref of data.refs) {
        const shape = refTable(ref.table);
        this.db.update(shape).set(ref.before).where(eq(shape.id, ref.id)).run();
        reindex[ref.table].add(ref.id);
      }
      unblockNames(this.db, data.blockedIds);
    });
    this.ctx.events.changed(...CHANGED_SCOPES);
    await this.runReindex(reindex);
    const restored = `„${snapshot.node.name}“ wiederhergestellt.`;
    return skipped > 0 ? `${restored} ${skipped} Verknüpfung(en) nicht, weil der andere Eintrag inzwischen fehlt.` : restored;
  }

  private async runReindex(refs: RefSets): Promise<void> {
    try {
      await this.reindexer({ documents: [...refs.documents], decisions: [...refs.decisions], openItems: [...refs.openItems], events: [...refs.events] });
    } catch (err) {
      this.ctx.logger.warn('knowledge', 'Reindexing after deleting a subject failed', { error: err });
    }
  }
}
