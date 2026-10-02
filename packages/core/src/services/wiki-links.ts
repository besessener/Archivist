import type { EntityType, GraphEntity } from '@archivist/shared';
import type { AppContext } from '../context';
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
  for (const m of text.matchAll(WIKI_LINK)) {
    const name = (m[1] ?? '').replace(/\s+/g, ' ').trim();
    const key = normalizeName(name);
    if (!name || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

const evidenceOf = (name: string) => `[[${name}]]`;

export interface WikiSuggestion {
  id: string;
  type: EntityType;
  name: string;
  /** The alias the query matched (the link then uses the real name). */
  alias: string | null;
}

/**
 * Wiki links in notes (#285): a `[[Name]]` becomes a manual relation (method `wikilink`, confirmed) from the note to the
 * entry of that name or alias; a link removed from the text removes its relation. The relation keeps the link text as
 * its evidence, so a renamed or merged target keeps its link even when the old name no longer resolves.
 */
export class WikiLinks {
  constructor(
    private readonly ctx: AppContext,
    private readonly graph: KnowledgeGraphService,
  ) {}

  private get sqlite() {
    return this.ctx.database.sqlite;
  }

  /** A target counts: not discarded as a duplicate; a document only once archived or indexed. */
  private usable(e: GraphEntity | undefined, selfId?: string): e is GraphEntity {
    if (!e || e.id === selfId || e.duplicateOfId) return false;
    if (e.type !== 'document') return true;
    return Boolean(this.sqlite.prepare(`SELECT 1 FROM documents WHERE id = ? AND status IN ('archived','indexed_only')`).get(e.id));
  }

  /** The entry a name stands for: exact name first, then a unique alias – in the order of {@link TARGET_TYPES}. */
  resolve(name: string, selfId?: string): GraphEntity | undefined {
    for (const type of TARGET_TYPES) {
      const e = this.graph.findByName(type, name);
      if (this.usable(e, selfId)) return e;
    }
    for (const type of TARGET_TYPES) {
      const e = this.graph.findByNameOrAlias(type, name);
      if (this.usable(e, selfId)) return e;
    }
    return undefined;
  }

  /** Each linked name of a note with its target – null for a name without entry (shown as unknown). */
  resolveAll(names: string[], noteId?: string): Array<{ name: string; entity: { id: string; type: EntityType; name: string } | null }> {
    const kept = noteId ? this.current(noteId) : [];
    return names.map((name) => {
      const e = this.resolve(name, noteId) ?? this.keptTarget(kept, name);
      return { name, entity: e ? { id: e.id, type: e.type, name: e.name } : null };
    });
  }

  /** Autocomplete after `[[`: entries whose name or alias contains the query, names starting with it first. */
  suggest(query: string, opts: { limit?: number; excludeId?: string } = {}): WikiSuggestion[] {
    const q = normalizeName(query);
    const limit = opts.limit ?? 8;
    const types = TARGET_TYPES.map((t) => `'${t}'`).join(',');
    const rows = this.sqlite
      .prepare(
        `SELECT id, type, name, aliases FROM entities e WHERE e.type IN (${types}) AND e.duplicate_of_id IS NULL
           AND (e.type <> 'document' OR EXISTS (SELECT 1 FROM documents d WHERE d.id = e.id AND d.status IN ('archived','indexed_only')))
           AND (e.normalized_name LIKE ? OR e.aliases LIKE ?)
         ORDER BY CASE WHEN e.normalized_name LIKE ? THEN 0 ELSE 1 END, length(e.name), e.name LIMIT ?`,
      )
      .all(`%${q}%`, `%${query.trim()}%`, `${q}%`, limit * 3) as Array<{ id: string; type: EntityType; name: string; aliases: string }>;
    const out: WikiSuggestion[] = [];
    for (const r of rows) {
      if (r.id === opts.excludeId) continue;
      const byName = normalizeName(r.name).includes(q);
      const alias = byName ? null : ((JSON.parse(r.aliases) as string[]).find((a) => normalizeName(a).includes(q)) ?? null);
      if (!byName && !alias) continue;
      out.push({ id: r.id, type: r.type, name: r.name, alias });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** The note's current wiki-link relations. */
  private current(noteId: string) {
    return this.graph.relationsOf(noteId, { statuses: ['confirmed', 'proposed'] }).filter((r) => r.method === 'wikilink' && r.sourceEntityId === noteId);
  }

  private keptTarget(kept: ReturnType<WikiLinks['current']>, name: string): GraphEntity | undefined {
    const key = normalizeName(name);
    const r = kept.find((x) => x.evidence && normalizeName(x.evidence.slice(2, -2)) === key);
    return r ? this.graph.getEntity(r.targetEntityId) : undefined;
  }

  /**
   * Brings the note's wiki-link relations in line with its text: new links are created (confirmed, the user's own),
   * links no longer in the text are removed. A name that resolves to nothing keeps a relation that already carries it
   * (renamed or merged target); otherwise it is reported as unknown.
   */
  sync(noteId: string, text: string): { linked: number; removed: number; unknown: string[] } {
    const kept = this.current(noteId);
    const keep = new Set<string>();
    const unknown: string[] = [];
    let linked = 0;
    for (const name of wikiNames(text)) {
      const target = this.resolve(name, noteId);
      if (!target) {
        const key = normalizeName(name);
        const prev = kept.find((x) => x.evidence && normalizeName(x.evidence.slice(2, -2)) === key);
        if (prev) keep.add(prev.id);
        else unknown.push(name);
        continue;
      }
      const r = this.graph.link(noteId, target.id, 'relates_to', {
        status: 'confirmed',
        confidence: 1,
        resolvedByUser: true,
        origin: 'user',
        method: 'wikilink',
        evidence: evidenceOf(name),
      });
      if (!r) continue;
      keep.add(r.id);
      if (r.created) linked += 1;
    }
    let removed = 0;
    for (const r of kept)
      if (!keep.has(r.id)) {
        this.graph.deleteRelation(r.id);
        removed += 1;
      }
    return { linked, removed, unknown };
  }
}
