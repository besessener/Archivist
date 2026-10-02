import type { GraphEntity, GraphRelation, RelationMethod, RelationType } from '@archivist/shared';
import { and, eq, inArray, or } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { currentRun } from '../../agent/scope';
import { entities, relations } from '../../db/schema';
import { AppError } from '../../util/errors';
import { nowIso } from '../../util/ids';
import type { AuditService } from '../audit';
import type { GraphEntities } from './entities';
import { subtreeOf } from './hierarchy';
import {
  CASE_UNDO_TYPE,
  DECIDE_MANY_UNDO_TYPE,
  LINK_MANY_UNDO_TYPE,
  LINK_UNDO_TYPE,
  type CaseUndoData,
  type DecideManyUndoData,
  type LinkManyUndoData,
  type LinkUndoData,
} from './link-undo';
import type { GraphRelations } from './relations';
import { entityRow, findRelationRow, mapRelation, relationRow, type RelationKey, type RelationRow } from './rows';

export interface LinkEntriesOptions {
  status: 'confirmed' | 'proposed';
  trigger?: string;
  confidence?: number;
  origin?: 'user' | 'system';
  /** Default: `manual` for a link the user asked for, `agent` for a proposal of the agent (#270). */
  method?: RelationMethod;
  evidence?: string | null;
}

export interface LinkChange {
  add?: RelationKey[];
  remove?: string[];
}

export interface LinkChangeOptions {
  trigger?: string;
  action?: string;
  method?: RelationMethod;
  summary?: Record<string, unknown>;
}

/** Topics and projects can be subtopics of each other (#282). */
const SUBJECT_TYPES = new Set<string>(['topic', 'project']);

/** The user's link actions (knowledge page and agent alike): audited, each one undoable. */
export class UserLinks {
  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
    private readonly graph: { entities: GraphEntities; relations: GraphRelations },
  ) {}

  private get db() {
    return this.ctx.database.db;
  }

  /** Links two entries (#277): `confirmed` when the user asked for it, else a proposal; rejected pairs are refused. */
  linkEntries(key: RelationKey, options: LinkEntriesOptions): { relation: GraphRelation; created: boolean } {
    this.assertLinkable(key, options.status);
    const before = findRelationRow(this.db, key) ?? null;
    const confirmed = options.status === 'confirmed';
    const created = before && confirmed ? this.confirmRow(before) : this.linkAsAsked(key, options);
    const after = findRelationRow(this.db, key)!;
    if (after.status === 'rejected' && !confirmed) throw new AppError('validation_error', 'Diese Verknüpfung wurde abgelehnt.');
    this.audit.log({
      action: 'relation.link',
      actor: 'user',
      trigger: options.trigger ?? 'manual',
      confirmed,
      entityIds: [after.id, key.sourceId, key.targetId],
      before: before ? { status: before.status } : null,
      after: { status: after.status, relationType: key.relationType },
      undo: { type: LINK_UNDO_TYPE, data: { before, after } satisfies LinkUndoData },
    });
    this.ctx.events.changed('knowledge');
    return { relation: mapRelation(after), created };
  }

  private assertLinkable(key: RelationKey, status: LinkEntriesOptions['status']): void {
    if (key.sourceId === key.targetId) throw new AppError('validation_error', 'Ein Eintrag kann nicht mit sich selbst verknüpft werden.');
    const source = this.graph.entities.get(key.sourceId);
    const target = this.graph.entities.get(key.targetId);
    if (!source || !target) throw new AppError('validation_error', 'Einer der Einträge existiert nicht.');
    if (key.relationType === 'subtopic_of') this.assertSubtopic(source, target);
    if (status === 'proposed' && this.graph.relations.rejectedBetween(key.sourceId, key.targetId))
      throw new AppError('validation_error', `Die Verknüpfung „${source.name}“ – „${target.name}“ wurde abgelehnt und wird nicht wieder vorgeschlagen.`);
  }

  private assertSubtopic(child: GraphEntity, parent: GraphEntity): void {
    if (!SUBJECT_TYPES.has(child.type) || !SUBJECT_TYPES.has(parent.type))
      throw new AppError('validation_error', 'Nur Themen und Projekte können Unterthema eines anderen sein.');
    if (subtreeOf(this.ctx.database.sqlite, child.id).includes(parent.id))
      throw new AppError('validation_error', `„${parent.name}“ liegt bereits unter „${child.name}“ – das ergäbe einen Kreis.`);
  }

  /** Confirms an existing relation as the user's choice; never counts as created. */
  private confirmRow(row: RelationRow): boolean {
    if (row.status !== 'confirmed')
      this.db.update(relations).set({ status: 'confirmed', resolvedByUser: true, updatedAt: nowIso() }).where(eq(relations.id, row.id)).run();
    return false;
  }

  private linkAsAsked(key: RelationKey, options: LinkEntriesOptions): boolean {
    const confirmed = options.status === 'confirmed';
    const result = this.graph.relations.link(key, {
      confidence: options.confidence ?? (confirmed ? 1 : 0.6),
      status: options.status,
      resolvedByUser: confirmed,
      // proposals of the fixed link methods are the system's, not the user's (#270)
      origin: options.origin ?? 'user',
      method: options.method ?? (confirmed ? 'manual' : currentRun() ? 'agent' : undefined),
      evidence: options.evidence,
    });
    return result?.created ?? false;
  }

  /** Links several entries with one target as the user's confirmed choice (#286, #291); returns the number changed. */
  linkMany(request: { sourceIds: string[]; targetId: string; relationType: RelationType }, options: Omit<LinkChangeOptions, 'summary'>): number {
    const { targetId, relationType } = request;
    const target = this.graph.entities.get(targetId);
    if (!target) throw new AppError('validation_error', 'Das Ziel existiert nicht.');
    const add = [...new Set(request.sourceIds)].map((sourceId) => ({ sourceId, targetId, relationType }));
    return this.changeLinks({ add }, { ...options, summary: { target: target.name, relationType } });
  }

  /** Adds confirmed links and removes others in ONE audited, undoable step (#287, #291). */
  changeLinks(change: LinkChange, options: LinkChangeOptions): number {
    const { items, entityIds } = this.applyLinkChanges(change, options.method);
    if (!items.length) return 0;
    this.audit.log({
      action: options.action ?? 'relation.linkMany',
      actor: 'user',
      trigger: options.trigger ?? 'manual',
      confirmed: true,
      entityIds: [...entityIds],
      after: { ...options.summary, count: items.length },
      undo: { type: LINK_MANY_UNDO_TYPE, data: { items } satisfies LinkManyUndoData },
    });
    this.ctx.events.changed('knowledge');
    return items.length;
  }

  /** {@link changeLinks} without its audit entry – for an action that logs several parts as one undo step (#291). */
  applyLinkChanges(change: LinkChange, method?: RelationMethod): { items: LinkUndoData[]; entityIds: Set<string> } {
    const items: LinkUndoData[] = [];
    const entityIds = new Set<string>();
    this.ctx.database.transaction(() => {
      for (const key of change.add ?? []) {
        const item = this.addConfirmed(key, method);
        if (!item) continue;
        items.push(item);
        entityIds.add(key.sourceId).add(key.targetId);
      }
      for (const id of new Set(change.remove ?? [])) {
        const before = relationRow(this.db, id);
        if (!before) continue;
        this.db.delete(relations).where(eq(relations.id, id)).run();
        items.push({ before, after: null });
        entityIds.add(before.sourceEntityId).add(before.targetEntityId);
      }
    });
    if (items.length) this.ctx.events.changed('knowledge');
    return { items, entityIds };
  }

  /** Makes the link a confirmed user choice; undefined when it is invalid or already confirmed. */
  private addConfirmed(key: RelationKey, method: RelationMethod | undefined): LinkUndoData | undefined {
    if (key.sourceId === key.targetId || !this.graph.entities.get(key.sourceId) || !this.graph.entities.get(key.targetId)) return undefined;
    const before = findRelationRow(this.db, key) ?? null;
    if (before?.status === 'confirmed') return undefined;
    if (before) this.confirmRow(before);
    else this.graph.relations.link(key, { confidence: 1, status: 'confirmed', resolvedByUser: true, origin: 'user', method: method ?? 'manual' });
    return { before, after: findRelationRow(this.db, key) ?? null };
  }

  /** Removes a relation the user no longer wants; logged with undo. */
  unlinkEntries(relationId: string, options: { trigger?: string }): GraphRelation {
    const before = relationRow(this.db, relationId);
    if (!before) throw new AppError('validation_error', 'Beziehung nicht gefunden.');
    this.db.delete(relations).where(eq(relations.id, relationId)).run();
    this.audit.log({
      action: 'relation.unlink',
      actor: 'user',
      trigger: options.trigger ?? 'manual',
      confirmed: true,
      entityIds: [relationId, before.sourceEntityId, before.targetEntityId],
      before: { status: before.status },
      after: null,
      undo: { type: LINK_UNDO_TYPE, data: { before, after: null } satisfies LinkUndoData },
    });
    this.ctx.events.changed('knowledge');
    return mapRelation(before);
  }

  /** Confirms or rejects a relation as the user's decision (#306); logged with undo. */
  decideRelation(relationId: string, decision: { status: 'confirmed' | 'rejected'; trigger?: string }): GraphRelation {
    const { status, trigger } = decision;
    const before = relationRow(this.db, relationId);
    if (!before) throw new AppError('validation_error', 'Beziehung nicht gefunden.');
    // a more precise kind replaces the general „verwandt“ of the pair – both in one undo step (#284)
    if (status === 'confirmed' && before.method === 'refinement' && before.status === 'proposed') {
      this.decideRelations([relationId], { status, trigger });
      return this.graph.relations.get(relationId)!;
    }
    this.graph.relations.setStatus(relationId, { status, by: 'user' });
    const after = relationRow(this.db, relationId)!;
    this.audit.log({
      action: status === 'confirmed' ? 'relation.confirm' : 'relation.reject',
      actor: 'user',
      trigger: trigger ?? 'manual',
      confirmed: true,
      entityIds: [relationId],
      before: { status: before.status },
      after: { status },
      undo: { type: LINK_UNDO_TYPE, data: { before, after } satisfies LinkUndoData },
    });
    return mapRelation(after);
  }

  /** Decides several open proposals at once (#280): ONE audit entry, ONE undo step; returns the number decided. */
  decideRelations(ids: string[], decision: { status: 'confirmed' | 'rejected'; trigger?: string }): number {
    const { status } = decision;
    const unique = [...new Set(ids)];
    if (!unique.length) return 0;
    const rows = this.db
      .select()
      .from(relations)
      .where(and(inArray(relations.id, unique), eq(relations.status, 'proposed')))
      .all();
    if (!rows.length) return 0;
    const updatedAt = nowIso();
    // a confirmed more precise kind (#284) makes the general „verwandt“ of its pair outdated – part of the same undo
    const general = status === 'confirmed' ? rows.filter((row) => row.method === 'refinement').flatMap((row) => this.generalOf(row)) : [];
    this.ctx.database.transaction(() => {
      this.setStatuses(rows, { status, resolvedByUser: true, updatedAt });
      if (general.length) this.setStatuses(general, { status: 'outdated', updatedAt });
      this.audit.log({
        action: status === 'confirmed' ? 'relation.confirmMany' : 'relation.rejectMany',
        actor: 'user',
        trigger: decision.trigger ?? 'manual',
        confirmed: true,
        entityIds: rows.map((row) => row.id).slice(0, 200),
        before: { count: rows.length, status: 'proposed' },
        after: { count: rows.length, status },
        undo: { type: DECIDE_MANY_UNDO_TYPE, data: decideUndoData([...rows, ...general], updatedAt) },
      });
    });
    this.ctx.events.changed('knowledge');
    return rows.length;
  }

  /** The confirmed general „verwandt“ between the two ends of `row`, in either direction. */
  private generalOf(row: RelationRow): RelationRow[] {
    const { sourceEntityId: source, targetEntityId: target } = row;
    return this.db
      .select()
      .from(relations)
      .where(
        and(
          eq(relations.relationType, 'related_to'),
          eq(relations.status, 'confirmed'),
          or(
            and(eq(relations.sourceEntityId, source), eq(relations.targetEntityId, target)),
            and(eq(relations.sourceEntityId, target), eq(relations.targetEntityId, source)),
          ),
        ),
      )
      .all();
  }

  private setStatuses(rows: RelationRow[], change: Partial<Pick<RelationRow, 'status' | 'resolvedByUser' | 'updatedAt'>>): void {
    this.db
      .update(relations)
      .set(change)
      .where(
        inArray(
          relations.id,
          rows.map((row) => row.id),
        ),
      )
      .run();
  }

  /** Opens or closes a case („Vorgang“, #286); logged with undo. */
  setCaseStatus(id: string, change: { status: 'open' | 'closed'; trigger?: string }): GraphEntity {
    const { status } = change;
    const row = entityRow(this.db, id);
    if (row?.type !== 'case') throw new AppError('validation_error', 'Vorgang nicht gefunden.');
    const updatedAt = nowIso();
    this.db.update(entities).set({ status, updatedAt }).where(eq(entities.id, id)).run();
    this.audit.log({
      action: status === 'closed' ? 'case.close' : 'case.reopen',
      actor: 'user',
      trigger: change.trigger ?? 'manual',
      confirmed: true,
      entityIds: [id],
      before: { status: row.status },
      after: { status },
      undo: { type: CASE_UNDO_TYPE, data: { id, before: row.status, beforeUpdatedAt: row.updatedAt, afterUpdatedAt: updatedAt } satisfies CaseUndoData },
    });
    this.ctx.events.changed('knowledge');
    return this.graph.entities.get(id)!;
  }
}

function decideUndoData(rows: RelationRow[], updatedAt: string): DecideManyUndoData {
  return {
    before: rows.map((row) => ({ id: row.id, status: row.status, resolvedByUser: row.resolvedByUser, updatedAt: row.updatedAt })),
    after: Object.fromEntries(rows.map((row) => [row.id, updatedAt])),
  };
}
