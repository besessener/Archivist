import type { EntityType, GraphEntity } from '@archivist/shared';
import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import { relations } from '../db/schema';
import { AppError } from '../util/errors';
import { normalizeName } from '../util/text';
import { nowIso } from '../util/ids';
import type { AuditService } from './audit';
import { LINK_MANY_UNDO_TYPE, type KnowledgeGraphService, type LinkManyUndoData, type LinkUndoData } from './knowledge-graph';
import {
  planBulkAssignment,
  subjectRelation,
  SUBJECT_TABLE,
  type BulkAssignmentPlan,
  type BulkPlanSources,
  type LinkSpec,
  type MainSubjects,
  type SubjectKind,
} from './subject-assignment';
import { MAIN_UNDO_TYPE, registerSubjectUndo, TAGS_UNDO_TYPE } from './subject-undo';
import { COMPOSITE_UNDO_TYPE, type CompositeUndoData, type UndoService } from './undo';

/** Entries the lists can select for a bulk assignment (#291). */
const BULK_TYPES: EntityType[] = ['document', 'note', 'decision', 'task', 'question', 'event'];
const SUBJECT_KINDS = ['topic', 'project'] as const;
const NO_MAIN: MainSubjects = { topicId: null, projectId: null };

export interface SubjectRef {
  id: string;
  name: string;
}

export interface EntrySubjects {
  /** The main topic/project (the column; the folder in the archive follows it). */
  topic: SubjectRef | null;
  project: SubjectRef | null;
  /** Further topics/projects (#287): confirmed relations besides the main one. */
  extraTopics: SubjectRef[];
  extraProjects: SubjectRef[];
}

interface SubjectPatch {
  topics?: string[];
  projects?: string[];
}

type SubjectReindexer = (refs: { documents: string[]; decisions: string[]; openItems: string[]; events: string[] }) => Promise<void>;

interface SubjectRow {
  entryId: string;
  id: string;
  name: string;
  kind: SubjectKind;
}

const namesOf = (patch: SubjectPatch, kind: SubjectKind) => (kind === 'topic' ? patch.topics : patch.projects);
const extrasOf = (subjects: EntrySubjects, kind: SubjectKind) => (kind === 'topic' ? subjects.extraTopics : subjects.extraProjects);

/** Several topics and projects per entry (#287): the column stays the main one, further ones are confirmed relations. */
export class SubjectService {
  private reindexer: SubjectReindexer = async () => {};

  constructor(
    private readonly ctx: AppContext,
    private readonly graph: KnowledgeGraphService,
    private readonly audit: AuditService,
    undo: UndoService,
  ) {
    registerSubjectUndo(undo, { ctx, reindex: (ids) => this.reindexEntries(ids) });
  }

  /** Rebuilds the search entries of changed entries (their topic and project names are part of the indexed text). */
  setReindexer(reindexer: SubjectReindexer): void {
    this.reindexer = reindexer;
  }

  private get sqlite() {
    return this.ctx.database.sqlite;
  }

  private main(id: string, type: EntityType): MainSubjects {
    const table = SUBJECT_TABLE[type];
    if (!table) return NO_MAIN;
    const row = this.sqlite.prepare(`SELECT topic_id AS topicId, project_id AS projectId FROM ${table} WHERE id = ?`).get(id) as MainSubjects | undefined;
    return row ?? NO_MAIN;
  }

  /** Main and further topics/projects of several entries at once (one query each – for lists). */
  ofMany(ids: string[]): Record<string, EntrySubjects> {
    const out: Record<string, EntrySubjects> = {};
    const unique = [...new Set(ids)].slice(0, 1000);
    if (!unique.length) return out;
    const marks = unique.map(() => '?').join(',');
    const rows = this.sqlite
      .prepare(
        `SELECT e.id AS entryId, e.type AS entryType, s.id AS id, s.name AS name, s.type AS kind
         FROM relations r JOIN entities e ON e.id = r.source_entity_id JOIN entities s ON s.id = r.target_entity_id
         WHERE r.source_entity_id IN (${marks}) AND r.status = 'confirmed' AND s.type IN ('topic','project')
         ORDER BY s.name`,
      )
      .all(...unique) as SubjectRow[];
    const entryRows = this.sqlite.prepare(`SELECT id, type FROM entities WHERE id IN (${marks})`).all(...unique) as Array<{ id: string; type: EntityType }>;
    const types = new Map(entryRows.map((row) => [row.id, row.type]));
    for (const id of unique) {
      const type = types.get(id);
      if (type) out[id] = this.subjectsOf(id, type, rows);
    }
    return out;
  }

  private subjectsOf(id: string, type: EntityType, rows: SubjectRow[]): EntrySubjects {
    const main = this.main(id, type);
    const mine = rows.filter((row) => row.entryId === id);
    const ref = (subjectId: string | null) => (subjectId ? { id: subjectId, name: this.graph.getEntity(subjectId)?.name ?? '' } : null);
    const extras = (kind: SubjectKind, mainId: string | null) =>
      mine.filter((row) => row.kind === kind && row.id !== mainId).map((row) => ({ id: row.id, name: row.name }));
    return {
      topic: ref(main.topicId),
      project: ref(main.projectId),
      extraTopics: extras('topic', main.topicId),
      extraProjects: extras('project', main.projectId),
    };
  }

  of(id: string): EntrySubjects {
    const subjects = this.ofMany([id])[id];
    if (!subjects) throw new AppError('validation_error', 'Eintrag nicht gefunden.');
    return subjects;
  }

  private resolve(kind: SubjectKind | 'tag', name: string): string {
    return (this.graph.findByNameOrAlias(kind, name) ?? this.graph.ensureEntity(kind, name)).id;
  }

  /** Ids of the confirmed relations from an entry to a topic or project. */
  private confirmedLinkIds(id: string, targetId: string): string[] {
    return this.graph
      .relationsOf(id, { statuses: ['confirmed'] })
      .filter((relation) => relation.sourceEntityId === id && relation.targetEntityId === targetId)
      .map((relation) => relation.id);
  }

  /** Sets the further topics/projects by name (new names are created, unnamed ones removed) in ONE undo step. */
  setExtras(id: string, patch: SubjectPatch, opts: { trigger?: string } = {}): EntrySubjects {
    const entry = this.graph.getEntity(id);
    if (!entry || !SUBJECT_TABLE[entry.type]) throw new AppError('validation_error', 'Diesem Eintrag lassen sich keine Themen oder Projekte zuordnen.');
    const current = this.of(id);
    const add: LinkSpec[] = [];
    const remove: string[] = [];
    for (const kind of SUBJECT_KINDS) {
      const names = namesOf(patch, kind);
      if (!names) continue;
      const changes = this.extraChanges(entry, kind, names, current);
      add.push(...changes.add);
      remove.push(...changes.remove);
    }
    this.graph.changeLinks({ add, remove }, { trigger: opts.trigger, action: 'subjects.update', summary: { entry: entry.name } });
    if (add.length || remove.length) this.ctx.events.changed('documents', 'decisions', 'openItems', 'events');
    return this.of(id);
  }

  private extraChanges(entry: GraphEntity, kind: SubjectKind, names: string[], current: EntrySubjects): { add: LinkSpec[]; remove: string[] } {
    const mainId = kind === 'topic' ? current.topic?.id : current.project?.id;
    const wanted = new Set(
      names
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => this.resolve(kind, name))
        .filter((targetId) => targetId !== mainId),
    );
    const existing = extrasOf(current, kind);
    const add = [...wanted]
      .filter((targetId) => !existing.some((extra) => extra.id === targetId))
      .map((targetId) => ({ sourceId: entry.id, targetId, relationType: subjectRelation(entry.type, kind) }));
    const remove = existing.filter((extra) => !wanted.has(extra.id)).flatMap((extra) => this.confirmedLinkIds(entry.id, extra.id));
    return { add, remove };
  }

  /** Removes further topics/projects (#287) by name from several entries in ONE undo step; returns how many were removed. */
  removeFurther(ids: string[], patch: SubjectPatch, opts: { trigger?: string } = {}): number {
    const remove: string[] = [];
    for (const [id, subjects] of Object.entries(this.ofMany(ids)))
      for (const kind of SUBJECT_KINDS) {
        const names = new Set(namesOf(patch, kind)?.map((name) => normalizeName(name)) ?? []);
        for (const further of extrasOf(subjects, kind).filter((extra) => names.has(normalizeName(extra.name))))
          remove.push(...this.confirmedLinkIds(id, further.id));
      }
    const removed = this.graph.changeLinks({ remove }, { trigger: opts.trigger, action: 'subjects.removeFurther', summary: { ...patch } });
    if (removed) this.ctx.events.changed('documents', 'decisions', 'openItems', 'events');
    return removed;
  }

  /** Bulk assignment of a list's selection (#291) in ONE undo step: main value where missing, else a further one (#287). */
  async bulkAssign(
    ids: string[],
    patch: SubjectPatch & { tags?: string[]; caseId?: string | null },
    opts: { trigger?: string } = {},
  ): Promise<{ updated: number; auditId: string | null }> {
    const entries = [...new Set(ids)].flatMap((id) => {
      const entry = this.graph.getEntity(id);
      return entry && BULK_TYPES.includes(entry.type) ? [entry] : [];
    });
    if (!entries.length) throw new AppError('validation_error', 'Keine passenden Einträge ausgewählt.');
    const caseNode = patch.caseId ? this.graph.getEntity(patch.caseId) : undefined;
    if (patch.caseId && caseNode?.type !== 'case') throw new AppError('validation_error', 'Vorgang nicht gefunden.');
    const plan = planBulkAssignment(this.planSources(), { entries, patch, caseId: caseNode?.id ?? null });
    const steps = this.ctx.database.transaction(() => this.applyPlan(plan));
    if (!steps.length) return { updated: 0, auditId: null };
    const auditId = this.audit.log({
      action: 'entries.bulkAssign',
      actor: 'user',
      trigger: opts.trigger ?? 'manual',
      confirmed: true,
      entityIds: [...plan.touched, ...(caseNode ? [caseNode.id] : [])],
      after: { ...patch, count: plan.touched.size },
      undo: { type: COMPOSITE_UNDO_TYPE, data: { steps } satisfies CompositeUndoData },
    });
    await this.reindexEntries([...plan.touched]);
    this.ctx.events.changed('documents', 'decisions', 'openItems', 'events', 'knowledge');
    return { updated: plan.touched.size, auditId };
  }

  private planSources(): BulkPlanSources {
    return {
      resolve: (kind, name) => this.resolve(kind, name),
      mainOf: (id, type) => this.main(id, type),
      documentTags: (id) => JSON.parse((this.sqlite.prepare('SELECT tags FROM documents WHERE id = ?').get(id) as { tags: string }).tags) as string[],
    };
  }

  /** Writes the plan and returns its undo steps (none when nothing changed). */
  private applyPlan(plan: BulkAssignmentPlan): CompositeUndoData['steps'] {
    const now = nowIso();
    for (const main of plan.main) this.sqlite.prepare(`UPDATE ${main.table} SET ${main.col} = ?, updated_at = ? WHERE id = ?`).run(main.value, now, main.id);
    const tagged = plan.tags.filter((tagUndo) => tagUndo.added.length);
    for (const tagUndo of tagged)
      this.sqlite
        .prepare('UPDATE documents SET tags = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify([...tagUndo.before, ...tagUndo.added]), now, tagUndo.id);
    const mirrored = this.linkMirrors(plan.mirrors);
    const { items } = this.graph.applyLinkChanges({ add: plan.add });
    const steps: CompositeUndoData['steps'] = [];
    if (plan.main.length) steps.push({ type: MAIN_UNDO_TYPE, data: plan.main });
    if (tagged.length) steps.push({ type: TAGS_UNDO_TYPE, data: tagged });
    if (mirrored.length || items.length) steps.push({ type: LINK_MANY_UNDO_TYPE, data: { items: [...mirrored, ...items] } satisfies LinkManyUndoData });
    return steps;
  }

  /** The mirror of a main value is a field relation (it follows later changes of the field); added ones are the user's. */
  private linkMirrors(mirrors: LinkSpec[]): LinkUndoData[] {
    return mirrors.flatMap((mirror) => {
      const before = this.relationRow(mirror);
      if (before?.status === 'confirmed') return [];
      this.graph.link(mirror.sourceId, mirror.targetId, mirror.relationType, { status: 'confirmed', confidence: 0.9, method: 'field' });
      return [{ before, after: this.relationRow(mirror) }];
    });
  }

  private relationRow({ sourceId, targetId, relationType }: LinkSpec) {
    return (
      this.ctx.database.db
        .select()
        .from(relations)
        .where(and(eq(relations.sourceEntityId, sourceId), eq(relations.targetEntityId, targetId), eq(relations.relationType, relationType)))
        .get() ?? null
    );
  }

  private async reindexEntries(ids: string[]): Promise<void> {
    const byType = (types: EntityType[]) => ids.filter((id) => types.includes(this.graph.getEntity(id)?.type as EntityType));
    try {
      await this.reindexer({
        documents: byType(['document']),
        decisions: byType(['decision']),
        openItems: byType(['task', 'question']),
        events: byType(['event']),
      });
    } catch (err) {
      this.ctx.logger.warn('subjects', 'Reindex after bulk assignment failed', { error: err });
    }
  }
}
