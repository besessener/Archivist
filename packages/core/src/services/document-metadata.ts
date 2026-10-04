import type { DocumentRecord, ReanalysisProposal } from '@archivist/shared';
import { eq } from 'drizzle-orm';
import { documentReanalysis, documents } from '../db/schema';
import { AppError } from '../util/errors';
import { nowIso } from '../util/ids';
import { bulkChanges, type BulkPatch, type BulkTargets } from './document-bulk';
import { isArchivedStatus, type DocRow, type DocumentDeps } from './document-model';
import { mentionLink } from './graph/mention-link';
import type { RelationChangeSet } from './knowledge-graph';
import type { UndoService } from './undo';

interface DocumentMetadataUndo {
  id: string;
  before: {
    title: string;
    topicId: string | null;
    projectId: string | null;
    tags: string[];
    persons: string[];
    /** Missing in undo data written before bulk edits existed. */
    docType?: string | null;
    documentDate?: string | null;
    summary?: string | null;
  };
  /** Relation changes of the edit (absent in undo data written by older versions). */
  relations?: RelationChangeSet;
  /** Older undo data: relations created by the edit. */
  relationIds?: string[];
  afterUpdatedAt: string;
  /** Timestamp before the edit (absent in undo data written by older versions). */
  beforeUpdatedAt?: string;
}

export interface MetadataPatch {
  title?: string;
  topic?: string | null;
  project?: string | null;
  tags?: string[];
  persons?: string[];
}

function metadataUndo(row: DocRow, edit: { set: Partial<DocRow>; relations: RelationChangeSet }): DocumentMetadataUndo {
  return {
    id: row.id,
    before: {
      title: row.title,
      topicId: row.topicId,
      projectId: row.projectId,
      tags: row.tags,
      persons: row.persons,
      docType: row.docType,
      documentDate: row.documentDate,
      summary: row.summary,
    },
    relations: edit.relations,
    afterUpdatedAt: edit.set.updatedAt!,
    beforeUpdatedAt: row.updatedAt,
  };
}

/** Metadata edits of documents (assignment, overwrite, bulk), each logged with undo. */
export class DocumentMetadataEditor {
  constructor(private readonly deps: DocumentDeps) {}

  private get db() {
    return this.deps.ctx.database.db;
  }

  registerUndo(undo: UndoService): void {
    undo.register('document_metadata', {
      check: async (data) => this.undoConflicts(data as DocumentMetadataUndo),
      run: async (data) => {
        await this.revert(data as DocumentMetadataUndo);
        return 'Metadaten wiederhergestellt.';
      },
    });
    // a bulk assignment is ONE undo step (#291)
    undo.register('document_metadata_bulk', {
      check: async (data) => {
        const items = (data as { items: DocumentMetadataUndo[] }).items;
        return [...new Set(items.flatMap((d) => this.undoConflicts(d)))];
      },
      run: async (data) => {
        const items = (data as { items: DocumentMetadataUndo[] }).items;
        for (const d of items.toReversed()) await this.revert(d);
        return `Metadaten von ${items.length} Dokument(en) wiederhergestellt.`;
      },
    });
  }

  private undoConflicts(d: DocumentMetadataUndo): string[] {
    const row = this.db.select().from(documents).where(eq(documents.id, d.id)).get();
    if (!row) return ['Das Dokument existiert nicht mehr.'];
    const conflicts = row.updatedAt === d.afterUpdatedAt ? [] : ['Das Dokument wurde seit der Änderung erneut verändert.'];
    return [...conflicts, ...this.deps.graph.relationChangeConflicts(d.relations)];
  }

  private async revert(d: DocumentMetadataUndo): Promise<void> {
    const { graph } = this.deps;
    this.db.transaction(() => {
      this.db
        .update(documents)
        // the old timestamp comes back too: the document is as before, so earlier undo entries (e.g. moving it) stay valid
        .set({ ...d.before, updatedAt: d.beforeUpdatedAt ?? nowIso() })
        .where(eq(documents.id, d.id))
        .run();
      if (graph.getEntity(d.id))
        graph.registerNode({
          type: 'document',
          id: d.id,
          name: d.before.title,
          description: this.db.select().from(documents).where(eq(documents.id, d.id)).get()?.summary ?? null,
        });
      if (d.relations) graph.revertRelationChanges(d.relations);
      // undo data written before relation tracking existed only lists the created relations
      else for (const relationId of d.relationIds ?? []) graph.deleteRelation(relationId);
    });
    await this.deps.documents.indexDocument(d.id);
    this.deps.ctx.events.changed('documents', 'knowledge');
  }

  /** Assigns the document to a topic/project (confirmed relations); without a file action. */
  assign(id: string, request: { topic?: string; project?: string; trigger?: string }): DocumentRecord {
    const row = this.deps.documents.getRow(id);
    const set: Partial<DocRow> = { updatedAt: nowIso() };
    if (request.topic?.trim()) set.topicId = this.deps.graph.ensureEntity({ type: 'topic', name: request.topic }).id;
    if (request.project?.trim()) set.projectId = this.deps.graph.ensureEntity({ type: 'project', name: request.project }).id;
    const { changes } = this.deps.graph.trackRelationChanges(id, () =>
      this.deps.ctx.database.transaction(() => {
        this.db.update(documents).set(set).where(eq(documents.id, id)).run();
        this.syncAssignment(id, set);
      }),
    );
    this.deps.audit.log({
      action: 'document.assign',
      actor: 'user',
      trigger: request.trigger ?? 'manual',
      confirmed: true,
      entityIds: [id],
      before: { topicId: row.topicId, projectId: row.projectId },
      after: { topicId: set.topicId ?? row.topicId, projectId: set.projectId ?? row.projectId },
      undo: { type: 'document_metadata', data: metadataUndo(row, { set, relations: changes }) },
    });
    return this.afterEdit(id);
  }

  updateMetadata(id: string, patch: MetadataPatch): DocumentRecord {
    const row = this.deps.documents.getRow(id);
    // archived documents are part of the graph: their persons and tags are linked like on archiving (#274)
    const inGraph = isArchivedStatus(row.status);
    const set = this.metadataChanges(patch, { createPersons: inGraph });
    const { changes } = this.deps.graph.trackRelationChanges(id, () =>
      this.deps.ctx.database.transaction(() => {
        this.db.update(documents).set(set).where(eq(documents.id, id)).run();
        if (set.title) this.deps.graph.registerNode({ type: 'document', id, name: set.title, description: row.summary });
        this.syncAssignment(id, set);
        if (inGraph) this.syncPersonsAndTags(id, set);
      }),
    );
    this.deps.audit.log({
      action: 'document.updateMetadata',
      actor: 'user',
      trigger: 'manual',
      confirmed: true,
      entityIds: [id],
      before: { title: row.title, topicId: row.topicId, projectId: row.projectId, tags: row.tags },
      after: patch,
      undo: { type: 'document_metadata', data: metadataUndo(row, { set, relations: changes }) },
    });
    return this.afterEdit(id);
  }

  /** Applies a re-analysis proposal to an archived document (level 2, already confirmed): fills in, never clears; one undo step. */
  applyReanalysis(id: string, proposal: ReanalysisProposal): DocumentRecord {
    const row = this.deps.documents.getRow(id);
    if (!isArchivedStatus(row.status)) throw new AppError('validation_error', 'Der Vorschlag gilt nur für archivierte oder nur indexierte Dokumente.');
    const set: Partial<DocRow> = {
      ...this.metadataChanges(
        {
          title: proposal.title,
          topic: proposal.topic ?? undefined,
          project: proposal.project ?? undefined,
          tags: [...row.tags, ...proposal.tags],
          persons: [...row.persons, ...proposal.persons],
        },
        { createPersons: true },
      ),
      ...(proposal.docType ? { docType: proposal.docType } : {}),
      ...(proposal.summary ? { summary: proposal.summary } : {}),
      ...(proposal.documentDate ? { documentDate: proposal.documentDate } : {}),
    };
    const { changes } = this.deps.graph.trackRelationChanges(id, () =>
      this.deps.ctx.database.transaction(() => {
        this.db.update(documents).set(set).where(eq(documents.id, id)).run();
        this.deps.graph.registerNode({ type: 'document', id, name: set.title ?? row.title, description: set.summary ?? row.summary });
        this.syncAssignment(id, set);
        this.syncPersonsAndTags(id, set);
        this.db.delete(documentReanalysis).where(eq(documentReanalysis.documentId, id)).run();
      }),
    );
    this.deps.audit.log({
      action: 'document.applyReanalysis',
      actor: 'user',
      trigger: 'manual',
      confirmed: true,
      entityIds: [id],
      before: { title: row.title, docType: row.docType, topicId: row.topicId, projectId: row.projectId, tags: row.tags },
      after: { title: set.title, docType: set.docType, topicId: set.topicId, projectId: set.projectId, tags: set.tags },
      undo: { type: 'document_metadata', data: metadataUndo(row, { set, relations: changes }) },
    });
    return this.afterEdit(id);
  }

  private metadataChanges(patch: MetadataPatch, persons: { createPersons: boolean }): Partial<DocRow> {
    const { graph } = this.deps;
    const set: Partial<DocRow> = { updatedAt: nowIso() };
    if (patch.title !== undefined && patch.title.trim()) set.title = patch.title.trim().slice(0, 200);
    if (patch.tags) set.tags = [...new Set(patch.tags.map((t) => t.trim()).filter(Boolean))];
    if (patch.persons) set.persons = this.deps.persons.resolveNames(patch.persons, { context: 'document', create: persons.createPersons }).names;
    if (patch.topic !== undefined) set.topicId = patch.topic?.trim() ? graph.ensureEntity({ type: 'topic', name: patch.topic }).id : null;
    if (patch.project !== undefined) set.projectId = patch.project?.trim() ? graph.ensureEntity({ type: 'project', name: patch.project }).id : null;
    return set;
  }

  /** Sets or removes metadata of several documents at once (#291, #305); the whole batch is ONE undo step. */
  bulkUpdate(ids: string[], change: { patch: BulkPatch; trigger?: string }): { updated: DocumentRecord[]; auditId: string | null } {
    const { patch } = change;
    const unique = [...new Set(ids)];
    if (!unique.length) return { updated: [], auditId: null };
    const targets = this.bulkTargets(patch);
    const undoItems = unique.map((id) => this.bulkEdit(id, { patch, targets, single: unique.length === 1 }));
    const auditId = this.deps.audit.log({
      action: 'document.bulkUpdate',
      actor: 'user',
      trigger: change.trigger ?? 'manual',
      confirmed: true,
      entityIds: unique,
      after: patch,
      undo: { type: 'document_metadata_bulk', data: { items: undoItems } },
    });
    this.deps.documents.indexDocumentsInBackground(unique);
    this.deps.ctx.events.changed('documents', 'knowledge');
    return { updated: this.deps.documents.list({ ids: unique, limit: unique.length }), auditId };
  }

  /** Entities named by a bulk patch, resolved once for the whole batch. */
  private bulkTargets(patch: BulkPatch): BulkTargets {
    const { graph } = this.deps;
    const mainSubject = (kind: 'topic' | 'project', name: string | null | undefined) =>
      name === undefined ? undefined : name?.trim() ? graph.ensureEntity({ type: kind, name }).id : null;
    const addedSubject = (kind: 'topic' | 'project', name: string | undefined) =>
      name?.trim() ? (graph.findByNameOrAlias(kind, name.trim()) ?? graph.ensureEntity({ type: kind, name: name.trim() })).id : undefined;
    const lowerSet = (names: string[] | undefined) => new Set((names ?? []).map((x) => x.toLowerCase()));
    const topicId = mainSubject('topic', patch.topic);
    const projectId = mainSubject('project', patch.project);
    const addTopicId = addedSubject('topic', patch.addTopic);
    const addProjectId = addedSubject('project', patch.addProject);
    if (patch.caseId && graph.getEntity(patch.caseId)?.type !== 'case') throw new AppError('validation_error', 'Vorgang nicht gefunden.');
    return {
      topicId,
      projectId,
      addTopicId,
      addProjectId,
      addPersons: patch.addPersons?.length ? this.deps.persons.resolveNames(patch.addPersons, { context: 'document', create: true }).names : [],
      removeTags: lowerSet(patch.removeTags),
      removePersons: lowerSet(patch.removePersons),
    };
  }

  private bulkEdit(id: string, batch: { patch: BulkPatch; targets: BulkTargets; single: boolean }): DocumentMetadataUndo {
    const row = this.deps.documents.getRow(id);
    const changes = bulkChanges(row, batch);
    const set: Partial<DocRow> = { updatedAt: nowIso(), ...changes.set };
    const tracked = this.deps.graph.trackRelationChanges(id, () =>
      this.deps.ctx.database.transaction(() => {
        this.db.update(documents).set(set).where(eq(documents.id, id)).run();
        if (set.title) this.deps.graph.registerNode({ type: 'document', id, name: set.title, description: row.summary });
        this.syncAssignment(id, set);
        for (const [target, type] of changes.extra)
          this.deps.graph.link(
            { sourceId: id, targetId: target, relationType: type },
            { status: 'confirmed', resolvedByUser: true, origin: 'user', method: 'manual', confidence: 1 },
          );
      }),
    );
    return metadataUndo(row, { set, relations: tracked.changes });
  }

  private afterEdit(id: string): DocumentRecord {
    void this.deps.documents.indexDocument(id);
    this.deps.ctx.events.changed('documents', 'knowledge');
    return this.deps.documents.get(id);
  }

  /** Links the document to its (changed) topic/project; relations to the previous ones become outdated. */
  private syncAssignment(id: string, set: Partial<DocRow>): void {
    const { graph } = this.deps;
    if (set.topicId) graph.link({ sourceId: id, targetId: set.topicId, relationType: 'relates_to' }, { confidence: 0.9, status: 'confirmed', sourceIds: [id] });
    if (set.projectId)
      graph.link({ sourceId: id, targetId: set.projectId, relationType: 'belongs_to' }, { confidence: 0.9, status: 'confirmed', sourceIds: [id] });
    if (set.topicId !== undefined)
      graph.unlinkSystemRelations({ entityId: id, relationType: 'relates_to', keepIds: set.topicId ? [set.topicId] : [], otherType: 'topic' });
    if (set.projectId !== undefined)
      graph.unlinkSystemRelations({ entityId: id, relationType: 'belongs_to', keepIds: set.projectId ? [set.projectId] : [], otherType: 'project' });
  }

  /** Links an archived document to its (changed) persons and tags; automatic relations to removed ones become outdated. */
  private syncPersonsAndTags(id: string, set: Partial<DocRow>): void {
    const { graph } = this.deps;
    if (set.persons) {
      const people = this.deps.persons.resolveNames(set.persons, { context: 'document', create: false }).entities;
      for (const p of people) graph.link({ sourceId: p.id, targetId: id, relationType: 'mentioned_in' }, mentionLink(id));
      graph.unlinkSystemRelations({ entityId: id, relationType: 'mentioned_in', keepIds: people.map((p) => p.id), direction: 'in', otherType: 'person' });
    }
    if (set.tags) {
      const tagIds = set.tags.map((t) => graph.ensureEntity({ type: 'tag', name: t }).id);
      for (const tagId of tagIds)
        graph.link({ sourceId: id, targetId: tagId, relationType: 'relates_to' }, { confidence: 0.6, status: 'confirmed', sourceIds: [id] });
      graph.unlinkSystemRelations({ entityId: id, relationType: 'relates_to', keepIds: tagIds, otherType: 'tag' });
    }
  }
}
