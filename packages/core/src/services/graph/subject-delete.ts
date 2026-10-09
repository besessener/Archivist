import { isDeletableSubjectType, type EntityType } from '@archivist/shared';
import { eq, or, sql, type SQL } from 'drizzle-orm';
import type { AppContext } from '../../context';
import type { Db } from '../../db/database';
import { entities } from '../../db/schema';
import { AppError } from '../../util/errors';
import { nowIso } from '../../util/ids';
import { normalizeName } from '../../util/text';
import type { AuditService } from '../audit';
import type { UndoService } from '../undo';
import { blockNames, unblockNames } from './blocked-names';
import type { GraphEntities, NodeSnapshot } from './entities';
import {
  REF_TABLES,
  REF_TABLE_NAMES,
  TOPIC_OR_PROJECT,
  applyRefChange,
  changedColumns,
  column,
  fingerprints,
  refTable,
  selection,
  type RefChange,
} from './merge-references';
import { emptyRefSets, type MergeReindexer, type RefBefore, type RefRow, type RefSets, type RefTableName } from './merge-types';
import { entityRow, relationRowsOf, type EntityRow } from './rows';

/** Audit undo type of a deleted subject. */
export const SUBJECT_DELETE_UNDO_TYPE = 'entity.delete';

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

interface DeleteUndoData {
  snapshot: NodeSnapshot;
  refs: RefBefore[];
  blockedIds: string[];
  /** Fingerprints of the changed records right after the deletion; any difference blocks the undo. */
  after: Record<string, string | null>;
}

/** How the subject can appear in the records of one table. */
interface Subject {
  entity: EntityRow;
  names: Set<string>;
  /** The table's column listing names of this type (persons, participants, tags). */
  nameListColumn: string | undefined;
  /** A person can be the responsible person of an open item. */
  canBeResponsible: boolean;
  /** A topic or project can be a record's main topic or project. */
  occupiesTopicOrProject: boolean;
}

function subjectOf(entity: EntityRow, table: RefTableName): Subject {
  const spec = REF_TABLES[table];
  return {
    entity,
    names: new Set([entity.normalizedName, ...entity.aliases.map(normalizeName)]),
    nameListColumn: spec.lists[entity.type as EntityType],
    canBeResponsible: spec.responsible === true && entity.type === 'person',
    occupiesTopicOrProject: TOPIC_OR_PROJECT.has(entity.type),
  };
}

/** The record as it is left without the subject (pure). */
function withoutSubject(row: RefRow, subject: Subject): RefRow {
  const next: RefRow = { ...row };
  const { id } = subject.entity;
  if (subject.occupiesTopicOrProject) {
    for (const slot of ['topicId', 'projectId']) if (next[slot] === id) next[slot] = null;
  }
  if (subject.canBeResponsible && next.responsiblePersonId === id) next.responsiblePersonId = null;
  const listColumn = subject.nameListColumn;
  if (listColumn) next[listColumn] = (next[listColumn] as string[]).filter((name) => !subject.names.has(normalizeName(name)));
  return next;
}

function referencingConditions(table: RefTableName, subject: Subject): SQL[] {
  const shape = refTable(table);
  const conditions: SQL[] = [];
  if (subject.occupiesTopicOrProject) conditions.push(eq(shape.topicId, subject.entity.id), eq(shape.projectId, subject.entity.id));
  if (subject.canBeResponsible) conditions.push(eq(column(shape, 'responsiblePersonId'), subject.entity.id));
  if (subject.nameListColumn) conditions.push(sql`${column(shape, subject.nameListColumn)} != '[]'`);
  return conditions;
}

/** Documents, decisions, open items and events that reference the subject by id or by name. */
function recordChanges(db: Db, entity: EntityRow): RefChange[] {
  return REF_TABLE_NAMES.flatMap((table) => {
    const subject = subjectOf(entity, table);
    const conditions = referencingConditions(table, subject);
    if (conditions.length === 0) return [];
    const shape = refTable(table);
    const rows = db
      .select(selection(shape, ['id', 'title', ...REF_TABLES[table].columns]))
      .from(shape)
      .where(or(...conditions))
      .all() as RefRow[];
    return rows.flatMap((row) => {
      const next = withoutSubject(row, subject);
      const columns = changedColumns(table, { row, next });
      return columns.length ? [{ table, row, next, columns }] : [];
    });
  });
}

const isMain = (change: RefChange) => change.columns.some((name) => name === 'topicId' || name === 'projectId');

function impactOf(db: Db, { entity, changes }: { entity: EntityRow; changes: RefChange[] }): SubjectImpact {
  return {
    id: entity.id,
    type: entity.type as EntityType,
    name: entity.name,
    relations: relationRowsOf(db, entity.id).filter((relation) => ACTIVE_RELATION.has(relation.status)).length,
    records: changes.map((change) => ({
      table: change.table,
      id: String(change.row.id),
      title: String(change.row.title),
      main: isMain(change),
    })),
  };
}

export type SubjectDeletionDeps = { ctx: AppContext; audit: AuditService; undo: UndoService; nodes: Pick<GraphEntities, 'snapshot' | 'remove' | 'restore'> };

export interface SubjectDeleteOptions {
  actor: 'user' | 'agent';
  trigger: string;
  /** Stage 2: only with the user's explicit confirmation (the dialog, or the request in the chat). */
  confirmed: boolean;
  reason?: string;
}

/** Deleting a named subject (person, topic, project, tag) with all its edges; the name stays blocked for the analysis; exact undo. */
export class SubjectDeletion {
  private reindexer: MergeReindexer = async () => {};

  private readonly ctx: AppContext;
  private readonly audit: AuditService;
  private readonly nodes: SubjectDeletionDeps['nodes'];

  constructor(deps: SubjectDeletionDeps) {
    this.ctx = deps.ctx;
    this.audit = deps.audit;
    this.nodes = deps.nodes;
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
    const entity = this.deletable(id);
    return impactOf(this.db, { entity, changes: recordChanges(this.db, entity) });
  }

  async delete(id: string, options: SubjectDeleteOptions): Promise<SubjectDeleteResult> {
    if (!options.confirmed) throw new AppError('permission_error', 'Das Löschen eines Eintrags erfordert eine ausdrückliche Bestätigung.');
    const entity = this.deletable(id);
    const changes = recordChanges(this.db, entity);
    const impact = impactOf(this.db, { entity, changes });
    const snapshot = this.nodes.snapshot(id);
    if (!snapshot) throw new AppError('validation_error', 'Eintrag nicht gefunden.');
    const reindex = emptyRefSets();
    const now = nowIso();
    const auditId = this.ctx.database.transaction(() => {
      const refs = changes.map((change) => applyRefChange(this.db, { ...change, now }));
      for (const ref of refs) reindex[ref.table].add(ref.id);
      this.nodes.remove(id);
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
    if (!isDeletableSubjectType(entity.type)) throw new AppError('validation_error', `„${entity.name}“ ist keine Person, kein Thema, Projekt oder Schlagwort.`);
    return entity;
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
      skipped = this.nodes.restore(snapshot);
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
