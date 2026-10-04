import type { GraphEntity, RelationType } from '@archivist/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { AppContext } from '../context';
import { entities } from '../db/schema';
import { AppError } from '../util/errors';
import { newId } from '../util/ids';
import { normalizeName, truncate } from '../util/text';
import type { AuditService } from './audit';
import type { NodeSnapshot } from './graph/entities';
import type { AdoptedRelation } from './graph/relations';
import type { KnowledgeGraphService } from './knowledge-graph';
import type { SearchService } from './search';
import type { UndoService } from './undo';
import { WikiLinks } from './wiki-links';

/** Undo of a note edit (#273): the former title and text. */
const NOTE_UPDATE_UNDO = 'note.update';
interface NoteUpdateUndo {
  id: string;
  before: { name: string; description: string | null };
  afterUpdatedAt: string;
  /** Relations the edit's wiki links took over (missing in entries from before). */
  adopted?: AdoptedRelation[];
}

/** Undo of deleting a note: its node with relations. */
const NOTE_DELETE_UNDO = 'note.delete';
interface NoteDeleteUndo {
  snapshot: NodeSnapshot;
}

export interface NoteInput {
  /** Full text of the note (stored as the node description and indexed for search). */
  content: string;
  /** Display name; defaults to the first 70 characters of the content. */
  title?: string | null;
  /** Confirmed links from the note to existing graph nodes (topic, open item …). */
  links?: Array<{ targetId: string; relationType: RelationType; confidence?: number }>;
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();
const sameText = (a: string, b: string) => collapse(a).toLowerCase() === collapse(b).toLowerCase();

export type NoteServiceDeps = { ctx: AppContext; graph: KnowledgeGraphService; search: SearchService; audit?: AuditService; undo?: UndoService };

/** The single place where notes are created: each is its own indexed graph node, never merged for a similar title. */
export class NoteService {
  /** `[[Name]]` links in the text (#285). */
  readonly wiki: WikiLinks;

  private readonly ctx: AppContext;
  private readonly graph: KnowledgeGraphService;
  private readonly search: SearchService;
  private readonly audit?: AuditService;

  constructor(deps: NoteServiceDeps) {
    ({ ctx: this.ctx, graph: this.graph, search: this.search, audit: this.audit } = deps);
    const { ctx, graph, undo } = deps;
    this.wiki = new WikiLinks(ctx, graph);
    undo?.register(NOTE_UPDATE_UNDO, {
      check: async (data) => this.updateConflicts(data as NoteUpdateUndo),
      run: async (data) => this.revertUpdate(data as NoteUpdateUndo),
    });
    undo?.register(NOTE_DELETE_UNDO, {
      check: async (data) => this.deleteConflicts(data as NoteDeleteUndo),
      run: async (data) => this.restoreDeleted(data as NoteDeleteUndo),
    });
  }

  private deleteConflicts(undoData: NoteDeleteUndo): string[] {
    return this.graph.getEntity(undoData.snapshot.node.id) ? ['Die Notiz ist bereits wiederhergestellt.'] : [];
  }

  private async restoreDeleted({ snapshot }: NoteDeleteUndo): Promise<string> {
    const skipped = this.graph.restoreNode(snapshot);
    await this.reindex(snapshot.node.id);
    this.ctx.events.emit('entry:updated', { id: snapshot.node.id, type: 'note' });
    this.ctx.events.changed('knowledge', 'status');
    return skipped > 0 ? `Notiz wiederhergestellt. ${skipped} Verknüpfung(en) nicht, weil inzwischen entfernt.` : 'Notiz wiederhergestellt.';
  }

  /** Deletes a note from the graph and the search index; undoable (#248). */
  delete(id: string, opts: { confirmed: boolean; trigger?: string }): void {
    if (!opts.confirmed) throw new AppError('permission_error', 'Das Löschen einer Notiz erfordert eine ausdrückliche Bestätigung.');
    const note = this.graph.getEntity(id);
    if (note?.type !== 'note') throw new AppError('validation_error', 'Notiz nicht gefunden.');
    const snapshot = this.graph.snapshotNode(id);
    if (!snapshot) throw new AppError('validation_error', 'Notiz nicht gefunden.');
    this.graph.removeNode(id);
    this.search.remove(id);
    this.audit?.log({
      action: 'note.delete',
      actor: 'user',
      trigger: opts.trigger ?? 'manual',
      confirmed: true,
      entityIds: [id],
      before: { title: note.name },
      undo: { type: NOTE_DELETE_UNDO, data: { snapshot } satisfies NoteDeleteUndo },
    });
    this.ctx.events.changed('knowledge', 'status');
  }

  private updateConflicts(undoData: NoteUpdateUndo): string[] {
    const note = this.graph.getEntity(undoData.id);
    if (!note) return ['Die Notiz existiert nicht mehr.'];
    return note.updatedAt === undoData.afterUpdatedAt ? [] : ['Die Notiz wurde seit der Bearbeitung verändert.'];
  }

  private async revertUpdate(undoData: NoteUpdateUndo): Promise<string> {
    const { id, before } = undoData;
    this.graph.registerNode({ type: 'note', id, name: before.name, description: before.description });
    this.graph.restoreAdoptedRelations(undoData.adopted ?? []);
    this.wiki.sync(id, before.description ?? before.name);
    await this.reindex(id);
    // the analysis runs again on the former text: its relations come back, the newer ones become outdated
    this.ctx.events.emit('entry:updated', { id, type: 'note' });
    this.ctx.events.changed('knowledge');
    return `Notiz „${before.name}“ wiederhergestellt.`;
  }

  /** Changes title and/or text of a note (#273), with undo; afterwards it is indexed and analysed again (`entry:updated`). */
  async update(
    id: string,
    { patch, ...opts }: { patch: { title?: string | null; content?: string | null }; trigger?: string; actor?: 'user' | 'agent' },
  ): Promise<GraphEntity> {
    const note = this.graph.getEntity(id);
    if (note?.type !== 'note') throw new AppError('validation_error', 'Notiz nicht gefunden.');
    if (note.duplicateOfId) throw new AppError('validation_error', 'Diese Notiz wurde als Duplikat verworfen.');
    const content = patch.content?.trim() || note.description || note.name;
    const title = collapse(patch.title ?? '') || (patch.content !== undefined ? truncate(collapse(content), 70) : note.name);
    if (title === note.name && content === (note.description ?? note.name)) return note;
    this.graph.registerNode({ type: 'note', id, name: title, description: content });
    const { adopted } = this.wiki.sync(id, content);
    const after = this.graph.getEntity(id)!;
    this.audit?.log({
      action: 'note.update',
      actor: opts.actor ?? 'user',
      trigger: opts.trigger ?? 'manual',
      confirmed: true,
      entityIds: [id],
      before: { title: note.name },
      after: { title },
      undo: {
        type: NOTE_UPDATE_UNDO,
        data: { id, before: { name: note.name, description: note.description }, afterUpdatedAt: after.updatedAt, adopted } satisfies NoteUpdateUndo,
      },
    });
    await this.reindex(id);
    this.ctx.events.emit('entry:updated', { id, type: 'note' });
    this.ctx.events.changed('knowledge');
    return after;
  }

  private resolve(input: NoteInput): { title: string; content: string } {
    const content = input.content.trim();
    const title = collapse(input.title ?? '') || truncate(collapse(content), 70);
    if (!content || !title) throw new AppError('validation_error', 'Eine Notiz braucht einen Inhalt.');
    return { title, content };
  }

  /** Finds a note with the same title and the same content (whitespace and case are ignored); discarded duplicates do not count. */
  findIdentical(input: NoteInput): GraphEntity | undefined {
    const { title, content } = this.resolve(input);
    const candidates = this.ctx.database.db
      .select({ id: entities.id, name: entities.name, description: entities.description })
      .from(entities)
      .where(and(eq(entities.type, 'note'), eq(entities.normalizedName, normalizeName(title)), isNull(entities.duplicateOfId)))
      .all();
    const hit = candidates.find((candidate) => sameText(candidate.description ?? candidate.name, content));
    return hit ? this.graph.getEntity(hit.id) : undefined;
  }

  /** Always creates a new note. */
  async create(input: NoteInput): Promise<GraphEntity> {
    const { title, content } = this.resolve(input);
    const id = newId();
    this.graph.registerNode({ type: 'note', id, name: title, description: content });
    this.applyLinks(id, input);
    this.wiki.sync(id, content);
    this.ctx.events.created({ id, type: 'note' });
    await this.search.index({ type: 'note', id, title, content });
    this.ctx.events.changed('knowledge');
    return this.graph.getEntity(id)!;
  }

  /** Returns an identical existing note (and still adds the requested links) or creates a new one. */
  async createUnlessExists(input: NoteInput): Promise<{ note: GraphEntity; created: boolean }> {
    const existing = this.findIdentical(input);
    if (!existing) return { note: await this.create(input), created: true };
    this.applyLinks(existing.id, input);
    return { note: existing, created: false };
  }

  /** Rebuilds the search index entry of a note; a note discarded as a duplicate is not searchable. */
  async reindex(id: string): Promise<void> {
    const note = this.graph.getEntity(id);
    if (!note || note.type !== 'note') return;
    if (note.duplicateOfId) {
      this.search.remove(id);
      return;
    }
    try {
      await this.search.index({ type: 'note', id, title: note.name, content: note.description ?? note.name });
    } catch (err) {
      this.ctx.logger.warn('notes', 'Indexing failed', { error: err });
    }
  }

  private applyLinks(noteId: string, input: NoteInput): void {
    for (const link of input.links ?? [])
      this.graph.link(
        { sourceId: noteId, targetId: link.targetId, relationType: link.relationType },
        { confidence: link.confidence ?? 0.9, status: 'confirmed' },
      );
  }
}
