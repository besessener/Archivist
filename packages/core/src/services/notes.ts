import type { GraphEntity, RelationType } from '@archivist/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { AppContext } from '../context';
import { entities } from '../db/schema';
import { AppError } from '../util/errors';
import { newId } from '../util/ids';
import { normalizeName, truncate } from '../util/text';
import type { KnowledgeGraphService } from './knowledge-graph';
import type { SearchService } from './search';

export interface NoteInput {
  /** Full text of the note (stored as the node description and indexed for search). */
  content: string;
  /** Display name; defaults to the first 70 characters of the content. */
  title?: string | null;
  /** Confirmed links from the note to existing graph nodes (topic, open item …). */
  links?: Array<{ targetId: string; relationType: RelationType; confidence?: number }>;
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
const sameText = (a: string, b: string) => collapse(a).toLowerCase() === collapse(b).toLowerCase();

/**
 * The single place where notes are created (knowledge page, chat, solution proposals).
 * Every note is its own graph node with its own id and is indexed for search; notes are
 * never merged just because their titles start the same way.
 */
export class NoteService {
  constructor(
    private readonly ctx: AppContext,
    private readonly graph: KnowledgeGraphService,
    private readonly search: SearchService,
  ) {}

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
    const hit = candidates.find((c) => sameText(c.description ?? c.name, content));
    return hit ? this.graph.getEntity(hit.id) : undefined;
  }

  /** Always creates a new note. */
  async create(input: NoteInput): Promise<GraphEntity> {
    const { title, content } = this.resolve(input);
    const id = newId();
    this.graph.registerNode('note', id, title, content);
    this.applyLinks(id, input);
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
      this.ctx.logger.warn('notes', 'Indexierung fehlgeschlagen', { error: err });
    }
  }

  private applyLinks(noteId: string, input: NoteInput): void {
    for (const l of input.links ?? []) this.graph.link(noteId, l.targetId, l.relationType, { confidence: l.confidence ?? 0.9, status: 'confirmed' });
  }
}
