import type { EntityType, RelationType } from '@archivist/shared';
import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import { relations } from '../db/schema';
import { AppError } from '../util/errors';
import { nowIso } from '../util/ids';
import type { AuditService } from './audit';
import { LINK_MANY_UNDO_TYPE, type KnowledgeGraphService, type LinkManyUndoData } from './knowledge-graph';
import { COMPOSITE_UNDO_TYPE, type CompositeUndoData, type UndoService } from './undo';

/** Undo of main topics/projects a bulk assignment set (#291). */
const MAIN_UNDO = 'subjects.main';
interface MainUndo {
  table: string;
  col: 'topic_id' | 'project_id';
  id: string;
  value: string;
}
/** Undo of a tag a bulk assignment added to documents (#291). */
const TAGS_UNDO = 'subjects.docTags';
interface TagUndo {
  id: string;
  before: string[];
  tag: string;
}
/** Entries the lists can select for a bulk assignment (#291). */
const BULK_TYPES: EntityType[] = ['document', 'note', 'decision', 'task', 'question', 'event'];

/** The table of each kind of entry that has a main topic/project column. */
const TABLE: Partial<Record<EntityType, string>> = {
  document: 'documents',
  decision: 'decisions',
  task: 'open_items',
  question: 'open_items',
  event: 'events',
};

/** The relation an entry has to a topic or project – the same the field mirror of the main column uses. */
export function subjectRelation(entryType: EntityType, subject: 'topic' | 'project'): RelationType {
  if (entryType === 'decision') return subject === 'topic' ? 'concerns' : 'affects';
  return subject === 'topic' ? 'relates_to' : 'belongs_to';
}

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

/**
 * Several topics and projects per entry (#287): the topic/project column of a document, decision, open item or event
 * stays its main assignment – the archive folder follows it – and further topics and projects are confirmed relations of
 * the same kind as the field mirror. Lists and filters count both; changing the further ones is ONE undo step.
 */
export class SubjectService {
  private reindexer: ((refs: { documents: string[]; decisions: string[]; openItems: string[]; events: string[] }) => Promise<void>) | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly graph: KnowledgeGraphService,
    private readonly audit: AuditService,
    undo: UndoService,
  ) {
    undo.register(MAIN_UNDO, {
      check: async (data) => {
        const changed = (data as MainUndo[]).filter(
          (m) => (this.sqlite.prepare(`SELECT ${m.col} AS v FROM ${m.table} WHERE id = ?`).get(m.id) as { v: string | null } | undefined)?.v !== m.value,
        ).length;
        return changed ? [`Bei ${changed} Einträgen wurde Thema bzw. Projekt seither geändert.`] : [];
      },
      run: async (data) => {
        const items = data as MainUndo[];
        for (const m of items) this.sqlite.prepare(`UPDATE ${m.table} SET ${m.col} = NULL, updated_at = ? WHERE id = ?`).run(nowIso(), m.id);
        await this.reindexEntries(items.map((m) => m.id));
        this.ctx.events.changed('documents', 'decisions', 'openItems', 'events');
        return `Zuordnung bei ${items.length} Einträgen zurückgenommen.`;
      },
    });
    undo.register(TAGS_UNDO, {
      check: async (data) => {
        const changed = (data as TagUndo[]).filter((t) => {
          const now = JSON.parse(
            (this.sqlite.prepare('SELECT tags FROM documents WHERE id = ?').get(t.id) as { tags: string } | undefined)?.tags ?? '[]',
          ) as string[];
          return !now.includes(t.tag);
        }).length;
        return changed ? [`Bei ${changed} Dokumenten wurden die Tags seither geändert.`] : [];
      },
      run: async (data) => {
        const items = data as TagUndo[];
        for (const t of items) {
          const now = JSON.parse((this.sqlite.prepare('SELECT tags FROM documents WHERE id = ?').get(t.id) as { tags: string }).tags) as string[];
          this.sqlite.prepare('UPDATE documents SET tags = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(now.filter((x) => x !== t.tag)), nowIso(), t.id);
        }
        await this.reindexEntries(items.map((t) => t.id));
        this.ctx.events.changed('documents');
        return `Tag bei ${items.length} Dokumenten entfernt.`;
      },
    });
  }

  /** Rebuilds the search entries of changed entries (their topic and project names are part of the indexed text). */
  setReindexer(fn: (refs: { documents: string[]; decisions: string[]; openItems: string[]; events: string[] }) => Promise<void>): void {
    this.reindexer = fn;
  }

  private get sqlite() {
    return this.ctx.database.sqlite;
  }

  private main(id: string, type: EntityType): { topicId: string | null; projectId: string | null } {
    const table = TABLE[type];
    if (!table) return { topicId: null, projectId: null };
    return (
      (this.sqlite.prepare(`SELECT topic_id AS topicId, project_id AS projectId FROM ${table} WHERE id = ?`).get(id) as
        { topicId: string | null; projectId: string | null } | undefined) ?? { topicId: null, projectId: null }
    );
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
      .all(...unique) as Array<{ entryId: string; entryType: EntityType; id: string; name: string; kind: 'topic' | 'project' }>;
    const types = new Map(
      (this.sqlite.prepare(`SELECT id, type FROM entities WHERE id IN (${marks})`).all(...unique) as Array<{ id: string; type: EntityType }>).map((r) => [
        r.id,
        r.type,
      ]),
    );
    const name = (id: string | null) => (id ? { id, name: this.graph.getEntity(id)?.name ?? '' } : null);
    for (const id of unique) {
      const type = types.get(id);
      if (!type) continue;
      const m = this.main(id, type);
      const mine = rows.filter((r) => r.entryId === id);
      out[id] = {
        topic: name(m.topicId),
        project: name(m.projectId),
        extraTopics: mine.filter((r) => r.kind === 'topic' && r.id !== m.topicId).map((r) => ({ id: r.id, name: r.name })),
        extraProjects: mine.filter((r) => r.kind === 'project' && r.id !== m.projectId).map((r) => ({ id: r.id, name: r.name })),
      };
    }
    return out;
  }

  of(id: string): EntrySubjects {
    const s = this.ofMany([id])[id];
    if (!s) throw new AppError('validation_error', 'Eintrag nicht gefunden.');
    return s;
  }

  private resolve(kind: 'topic' | 'project', name: string): string {
    return (this.graph.findByNameOrAlias(kind, name) ?? this.graph.ensureEntity(kind, name)).id;
  }

  /**
   * Sets the further topics and/or projects of an entry (by name; new names are created) – the main one stays. What is
   * no longer named is removed. ONE undo step. Returns the entry's topics/projects afterwards.
   */
  setExtras(id: string, patch: { topics?: string[]; projects?: string[] }, opts: { trigger?: string } = {}): EntrySubjects {
    const entry = this.graph.getEntity(id);
    if (!entry || !TABLE[entry.type]) throw new AppError('validation_error', 'Diesem Eintrag lassen sich keine Themen oder Projekte zuordnen.');
    const current = this.of(id);
    const add: Array<{ sourceId: string; targetId: string; relationType: RelationType }> = [];
    const remove: string[] = [];
    for (const kind of ['topic', 'project'] as const) {
      const names = kind === 'topic' ? patch.topics : patch.projects;
      if (!names) continue;
      const main = kind === 'topic' ? current.topic?.id : current.project?.id;
      const wanted = new Set(
        names
          .map((n) => n.trim())
          .filter(Boolean)
          .map((n) => this.resolve(kind, n))
          .filter((x) => x !== main),
      );
      const now = kind === 'topic' ? current.extraTopics : current.extraProjects;
      for (const t of wanted) if (!now.some((n) => n.id === t)) add.push({ sourceId: id, targetId: t, relationType: subjectRelation(entry.type, kind) });
      for (const n of now)
        if (!wanted.has(n.id))
          remove.push(
            ...this.graph
              .relationsOf(id, { statuses: ['confirmed'] })
              .filter((r) => r.sourceEntityId === id && r.targetEntityId === n.id)
              .map((r) => r.id),
          );
    }
    this.graph.changeLinks({ add, remove }, { trigger: opts.trigger, action: 'subjects.update', summary: { entry: entry.name } });
    if (add.length || remove.length) this.ctx.events.changed('documents', 'decisions', 'openItems', 'events');
    return this.of(id);
  }

  /**
   * Bulk assignment of a list's selection (#291) – ONE undo step for all of it: a topic or project becomes the main
   * value of an entry that has none and a further one of the others (#287); a tag is added; a case collects the entries.
   */
  async bulkAssign(
    ids: string[],
    patch: { topic?: string | null; project?: string | null; tag?: string | null; caseId?: string | null },
    opts: { trigger?: string } = {},
  ): Promise<{ updated: number; auditId: string | null }> {
    const entries = [...new Set(ids)].flatMap((id) => {
      const e = this.graph.getEntity(id);
      return e && BULK_TYPES.includes(e.type) ? [e] : [];
    });
    if (!entries.length) throw new AppError('validation_error', 'Keine passenden Einträge ausgewählt.');
    const caseNode = patch.caseId ? this.graph.getEntity(patch.caseId) : null;
    if (patch.caseId && caseNode?.type !== 'case') throw new AppError('validation_error', 'Vorgang nicht gefunden.');
    const main: MainUndo[] = [];
    const tags: TagUndo[] = [];
    const mirrors: Array<{ sourceId: string; targetId: string; relationType: RelationType }> = [];
    const add: Array<{ sourceId: string; targetId: string; relationType: RelationType }> = [];
    const touched = new Set<string>();
    for (const kind of ['topic', 'project'] as const) {
      const name = patch[kind]?.trim();
      if (!name) continue;
      const targetId = this.resolve(kind, name);
      for (const e of entries) {
        const table = TABLE[e.type];
        const col = kind === 'topic' ? 'topic_id' : 'project_id';
        const cur = table ? this.main(e.id, e.type)[kind === 'topic' ? 'topicId' : 'projectId'] : null;
        if (cur === targetId) continue;
        if (table && !cur) {
          main.push({ table, col, id: e.id, value: targetId });
          mirrors.push({ sourceId: e.id, targetId, relationType: subjectRelation(e.type, kind) });
        } else add.push({ sourceId: e.id, targetId, relationType: subjectRelation(e.type, kind) });
        touched.add(e.id);
      }
    }
    const tagName = patch.tag?.trim();
    if (tagName) {
      const tagId = (this.graph.findByNameOrAlias('tag', tagName) ?? this.graph.ensureEntity('tag', tagName)).id;
      for (const e of entries) {
        if (e.type === 'document') {
          const before = JSON.parse((this.sqlite.prepare('SELECT tags FROM documents WHERE id = ?').get(e.id) as { tags: string }).tags) as string[];
          if (before.some((t) => t.toLowerCase() === tagName.toLowerCase())) continue;
          tags.push({ id: e.id, before, tag: tagName });
          mirrors.push({ sourceId: e.id, targetId: tagId, relationType: 'relates_to' });
        } else add.push({ sourceId: e.id, targetId: tagId, relationType: 'relates_to' });
        touched.add(e.id);
      }
    }
    if (caseNode)
      for (const e of entries.filter((x) => x.type !== 'case')) {
        add.push({ sourceId: e.id, targetId: caseNode.id, relationType: 'belongs_to' });
        touched.add(e.id);
      }
    const steps: CompositeUndoData['steps'] = [];
    this.ctx.database.transaction(() => {
      const now = nowIso();
      for (const m of main) this.sqlite.prepare(`UPDATE ${m.table} SET ${m.col} = ?, updated_at = ? WHERE id = ?`).run(m.value, now, m.id);
      for (const t of tags)
        this.sqlite.prepare('UPDATE documents SET tags = ?, updated_at = ? WHERE id = ?').run(JSON.stringify([...t.before, t.tag]), now, t.id);
      // the mirror of a main value is a field relation (it follows later changes of the field), added ones are the user's
      const mirrored = mirrors.flatMap((m) => {
        const before = this.relationRow(m.sourceId, m.targetId, m.relationType);
        if (before?.status === 'confirmed') return [];
        this.graph.link(m.sourceId, m.targetId, m.relationType, { status: 'confirmed', confidence: 0.9, method: 'field' });
        return [{ before, after: this.relationRow(m.sourceId, m.targetId, m.relationType) }];
      });
      const { items } = this.graph.applyLinkChanges({ add });
      if (main.length) steps.push({ type: MAIN_UNDO, data: main });
      if (tags.length) steps.push({ type: TAGS_UNDO, data: tags });
      if (mirrored.length || items.length) steps.push({ type: LINK_MANY_UNDO_TYPE, data: { items: [...mirrored, ...items] } satisfies LinkManyUndoData });
    });
    if (!steps.length) return { updated: 0, auditId: null };
    const auditId = this.audit.log({
      action: 'entries.bulkAssign',
      actor: 'user',
      trigger: opts.trigger ?? 'manual',
      confirmed: true,
      entityIds: [...touched, ...(caseNode ? [caseNode.id] : [])],
      after: { ...patch, count: touched.size },
      undo: { type: COMPOSITE_UNDO_TYPE, data: { steps } satisfies CompositeUndoData },
    });
    await this.reindexEntries([...touched]);
    this.ctx.events.changed('documents', 'decisions', 'openItems', 'events', 'knowledge');
    return { updated: touched.size, auditId };
  }

  private relationRow(sourceId: string, targetId: string, relationType: RelationType) {
    return (
      this.ctx.database.db
        .select()
        .from(relations)
        .where(and(eq(relations.sourceEntityId, sourceId), eq(relations.targetEntityId, targetId), eq(relations.relationType, relationType)))
        .get() ?? null
    );
  }

  private async reindexEntries(ids: string[]): Promise<void> {
    if (!this.reindexer) return;
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
