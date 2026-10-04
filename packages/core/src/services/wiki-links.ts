import type { EntityType, GraphEntity, GraphRelation } from '@archivist/shared';
import type { AppContext } from '../context';
import { currentRun } from '../agent/scope';
import type { AdoptedRelation } from './graph/relations';
import { normalizeName } from '../util/text';
import type { KnowledgeGraphService } from './knowledge-graph';

/** `[[Name]]` or `[[Name|shown text]]` (#285). */
const WIKI_LINK = /\[\[([^[\]|\n]{1,200})(?:\|[^[\]\n]{0,200})?\]\]/g;

/** Kinds a wiki link can point to, in the order a name is looked up (entries first, then the named nodes). */
const TARGET_TYPES: EntityType[] = ['note', 'document', 'decision', 'task', 'question', 'event', 'case', 'project', 'topic', 'person', 'tag'];

/** The names linked in a text, each once (trimmed, in order of appearance). */
export function wikiNames(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(WIKI_LINK)) {
    const name = (match[1] ?? '').replace(/\s+/g, ' ').trim();
    const key = normalizeName(name);
    if (!name || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

const evidenceOf = (name: string) => `[[${name}]]`;

/** The kept wiki-link relation whose link text (its evidence) names `name`. */
const keptLinkOf = (kept: GraphRelation[], name: string): GraphRelation | undefined => {
  const key = normalizeName(name);
  return kept.find((relation) => relation.evidence && normalizeName(relation.evidence.slice(2, -2)) === key);
};

export interface WikiSuggestion {
  id: string;
  type: EntityType;
  name: string;
  /** The alias the query matched (the link then uses the real name). */
  alias: string | null;
}

/** Wiki links in notes (#285): `[[Name]]` is a confirmed `wikilink` relation whose evidence keeps the link text for renamed targets. */
export class WikiLinks {
  constructor(
    private readonly ctx: AppContext,
    private readonly graph: KnowledgeGraphService,
  ) {}

  private get sqlite() {
    return this.ctx.database.sqlite;
  }

  /** A target counts: not discarded as a duplicate; a document only once archived or indexed. */
  private usable(entity: GraphEntity | undefined, selfId?: string): entity is GraphEntity {
    if (!entity || entity.id === selfId || entity.duplicateOfId) return false;
    if (entity.type !== 'document') return true;
    return Boolean(this.sqlite.prepare(`SELECT 1 FROM documents WHERE id = ? AND status IN ('archived','indexed_only')`).get(entity.id));
  }

  /** The entry a name stands for: exact name first, then a unique alias – in the order of {@link TARGET_TYPES}. */
  resolve(name: string, selfId?: string): GraphEntity | undefined {
    for (const type of TARGET_TYPES) {
      const entity = this.graph.findByName(type, name);
      if (this.usable(entity, selfId)) return entity;
    }
    for (const type of TARGET_TYPES) {
      const entity = this.graph.findByNameOrAlias(type, name);
      if (this.usable(entity, selfId)) return entity;
    }
    return undefined;
  }

  /** Each linked name of a note with its target – null for a name without entry (shown as unknown). */
  resolveAll(names: string[], noteId?: string): Array<{ name: string; entity: { id: string; type: EntityType; name: string } | null }> {
    const kept = noteId ? this.current(noteId) : [];
    return names.map((name) => {
      const entity = this.resolve(name, noteId) ?? this.keptTarget(kept, name);
      return { name, entity: entity ? { id: entity.id, type: entity.type, name: entity.name } : null };
    });
  }

  /** Autocomplete after `[[`: entries whose name or alias contains the query, names starting with it first. */
  suggest(query: string, opts: { limit?: number; excludeId?: string } = {}): WikiSuggestion[] {
    const normalized = normalizeName(query);
    const limit = opts.limit ?? 8;
    const types = TARGET_TYPES.map((t) => `'${t}'`).join(',');
    const rows = this.sqlite
      .prepare(
        `SELECT id, type, name, aliases FROM entities e WHERE e.type IN (${types}) AND e.duplicate_of_id IS NULL
           AND (e.type <> 'document' OR EXISTS (SELECT 1 FROM documents d WHERE d.id = e.id AND d.status IN ('archived','indexed_only')))
           AND (e.normalized_name LIKE ? OR e.aliases LIKE ?)
         ORDER BY CASE WHEN e.normalized_name LIKE ? THEN 0 ELSE 1 END, length(e.name), e.name LIMIT ?`,
      )
      .all(`%${normalized}%`, `%${query.trim()}%`, `${normalized}%`, limit * 3) as Array<{ id: string; type: EntityType; name: string; aliases: string }>;
    const out: WikiSuggestion[] = [];
    for (const row of rows) {
      if (row.id === opts.excludeId) continue;
      const byName = normalizeName(row.name).includes(normalized);
      const alias = byName ? null : ((JSON.parse(row.aliases) as string[]).find((a) => normalizeName(a).includes(normalized)) ?? null);
      if (!byName && !alias) continue;
      out.push({ id: row.id, type: row.type, name: row.name, alias });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** The note's current wiki-link relations. */
  private current(noteId: string): GraphRelation[] {
    return this.graph
      .relationsOf(noteId, { statuses: ['confirmed', 'proposed'] })
      .filter((relation) => relation.method === 'wikilink' && relation.sourceEntityId === noteId);
  }

  private keptTarget(kept: GraphRelation[], name: string): GraphEntity | undefined {
    const relation = keptLinkOf(kept, name);
    return relation ? this.graph.getEntity(relation.targetEntityId) : undefined;
  }

  /** Takes the note's relation to the target over as a wiki link unless it already is one; returns its former state. */
  private adopt(link: { noteId: string; targetId: string; name: string }): AdoptedRelation[] {
    const before = this.graph
      .relationsOf(link.noteId, { types: ['relates_to'] })
      .find((relation) => relation.sourceEntityId === link.noteId && relation.targetEntityId === link.targetId);
    if (!before || before.method === 'wikilink' || (before.resolvedByUser && before.status === 'confirmed')) return [];
    // only the user's own edit overrides their rejection, never an agent run
    if (before.status === 'rejected' && currentRun()) return [];
    this.graph.adoptAsWikiLink(before.id, evidenceOf(link.name));
    return [before];
  }

  /** Links become the user's own (also over a proposal or, outside an agent run, a rejection; `adopted` for undo), removed ones are deleted; an unresolved name keeps its relation. */
  sync(noteId: string, text: string): { linked: number; removed: number; unknown: string[]; adopted: AdoptedRelation[] } {
    const kept = this.current(noteId);
    const keep = new Set<string>();
    const unknown: string[] = [];
    const adopted: AdoptedRelation[] = [];
    let linked = 0;
    for (const name of wikiNames(text)) {
      const target = this.resolve(name, noteId);
      if (!target) {
        const previous = keptLinkOf(kept, name);
        if (previous) keep.add(previous.id);
        else unknown.push(name);
        continue;
      }
      adopted.push(...this.adopt({ noteId, targetId: target.id, name }));
      const result = this.graph.link(
        { sourceId: noteId, targetId: target.id, relationType: 'relates_to' },
        {
          status: 'confirmed',
          confidence: 1,
          resolvedByUser: true,
          origin: 'user',
          method: 'wikilink',
          evidence: evidenceOf(name),
        },
      );
      if (!result) continue;
      keep.add(result.id);
      if (result.created) linked += 1;
    }
    let removed = 0;
    for (const relation of kept.filter((x) => !keep.has(x.id))) {
      this.graph.deleteRelation(relation.id);
      removed += 1;
    }
    return { linked, removed, unknown, adopted };
  }
}
