import { createHash } from 'node:crypto';
import { localDate, RELATION_METHOD_LABELS, type EntityType, type GraphRelation, type RelationMethod } from '@archivist/shared';
import type { AppContext } from '../context';
import { currentRun } from '../agent/scope';
import { newId } from '../util/ids';
import type { CreatedEntry } from '../util/origin-scope';
import { normalizeName, tokenize, truncate } from '../util/text';
import type { AppStateService } from './app-state';
import type { InsightService } from './insights';
import { relationReason, type KnowledgeGraphService } from './knowledge-graph';
import type { SearchService } from './search';

/** Knowledge entries the link methods connect (documents only once archived or indexed). */
export const LINK_ENTRY_TYPES: EntityType[] = ['document', 'note', 'decision', 'task', 'question', 'event'];
/** Entries a topic can be assigned to with the same function as in the UI (`set_metadata` / bulk assignment). */
const TOPIC_ENTRY_TYPES: EntityType[] = ['document', 'decision', 'task', 'question', 'event'];

/**
 * Minimum cosine similarity of two entries' chunk vectors for a proposal (#271). The local hash vectors are lexical and
 * noisy: texts of the archive share words and headers, so unrelated entries still reach about 0.4 – their bar is higher
 * than that of real embeddings, whose unrelated texts stay well below 0.4.
 */
export const MIN_SIMILARITY = { local: 0.5, embeddings: 0.45 };

export interface LinkCandidate {
  id: string;
  type: EntityType;
  name: string;
  /** 0..1 */
  score: number;
  method: 'similarity' | 'mention';
  /** Why: the matching passage or the mentioned name. */
  reason: string;
}

/** Methods whose proposals are reviewed in the list of link proposals (#280); field mirrors and own flows are not. */
export const LINK_PROPOSAL_METHODS: RelationMethod[] = ['similarity', 'mention', 'co_origin', 'date_person', 'analysis', 'agent', 'wikilink'];
/** Relation types with a flow of their own (contradictions, versions, duplicates). */
const OWN_FLOW_TYPES = ['contradicts', 'supersedes', 'duplicate_of'];

export interface LinkProposal {
  relation: GraphRelation;
  source: { id: string; type: EntityType; name: string };
  target: { id: string; type: EntityType; name: string };
  /** The group the proposal belongs to (method or source entry). */
  groupKey: string;
}

export interface LinkProposalPage {
  /** All open proposals (not only this page). */
  total: number;
  /** Every group with its number of proposals, in the order of the list. */
  groups: Array<{ key: string; label: string; count: number }>;
  items: LinkProposal[];
}

/** An entry related to another one – directly or over shared topics, projects, persons, tags or cases (#276). */
export interface RelatedItem {
  entity: { id: string; type: EntityType; name: string; description: string | null };
  /** Strength: kind and number of the connections. */
  score: number;
  /** Plain-language reason, e.g. „gleiches Projekt „Hausbau“ + gleiche Person „Anna““. */
  reason: string;
  /** The direct relation, if any (proposals can be confirmed or rejected right there). */
  relation: GraphRelation | null;
  shared: Array<{ id: string; type: EntityType; name: string }>;
}

/** Weight of a shared node for the strength of an indirect connection (#276). */
const SHARED_WEIGHT: Partial<Record<EntityType, number>> = { project: 4, case: 4, topic: 3, person: 2, tag: 1 };
const SHARED_LABEL: Partial<Record<EntityType, string>> = {
  project: 'gleiches Projekt',
  case: 'gleicher Vorgang',
  topic: 'gleiches Thema',
  person: 'gleiche Person',
  tag: 'gleicher Tag',
};
/** Order of the shared nodes in a reason. */
const SHARED_ORDER: EntityType[] = ['project', 'case', 'topic', 'person', 'tag'];
/** A node shared with more entries than this says little about two of them (e.g. a tag on every document). */
const MAX_HUB_MEMBERS = 500;

export interface OrphanPage {
  total: number;
  items: Array<{ id: string; type: EntityType; name: string; createdAt: string }>;
}

export interface TopicCluster {
  /** Stable for the same members: a rejected proposal („Nein“) is remembered under it. */
  key: string;
  name: string;
  members: Array<{ id: string; type: EntityType; name: string }>;
}

export interface BackfillResult {
  processed: number;
  proposed: number;
  /** All entries are done (the next run starts over from the beginning). */
  done: boolean;
  remaining: number;
}

const BACKFILL_CURSOR = 'links.backfill.cursor';
/** Entries indexed since the last similarity pass (#271); kept across restarts. */
const SIMILAR_PENDING = 'links.similar.pending';
/** Up to this many entries created together are linked pairwise; more are linked in a chain (#272). */
const MAX_PAIRWISE = 6;
/** Tables of the entries that name their source documents in `source_ids`. */
const SOURCE_TABLES = ['decisions', 'open_items', 'events'] as const;

/** The business date of an entry (#278): event date, decision date, document date – never when it was captured or archived. */
const BUSINESS_DATE: Array<{ table: string; column: string; type: EntityType; extra?: string }> = [
  { table: 'events', column: 'occurred_at', type: 'event', extra: 'AND x.duplicate_of_id IS NULL' },
  { table: 'decisions', column: 'decided_at', type: 'decision' },
  { table: 'documents', column: 'document_date', type: 'document', extra: "AND x.status IN ('archived','indexed_only')" },
];
const dayShift = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const germanDay = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}`;

/** Default of the most open similarity proposals per entry (setting `links.maxProposalsPerEntry`). */
export const MAX_SIMILAR_PROPOSALS = 3;

/** SQL for an entry that counts: not discarded as a duplicate, documents only when archived or indexed. */
const ENTRY_SQL = (alias: string, types: EntityType[]) =>
  `${alias}.type IN (${types.map((t) => `'${t}'`).join(',')}) AND ${alias}.duplicate_of_id IS NULL AND (${alias}.type <> 'document' OR EXISTS (SELECT 1 FROM documents d WHERE d.id = ${alias}.id AND d.status IN ('archived','indexed_only')))`;

/**
 * The fixed link methods of Epic #269 as service functions – the user interface and the agent tools call the same ones
 * (#313): similar entries and mentioned topics/projects as candidates (#271, #283), entries without any link (#290), groups
 * of similar entries without a topic as a new topic (#281) and the retroactive run over the whole archive (#279).
 * They only ever PROPOSE: confirming is the user's. Pairs the user rejected are never proposed again.
 */
export class LinkMethodsService {
  constructor(
    private readonly ctx: AppContext,
    private readonly graph: KnowledgeGraphService,
    private readonly search: SearchService,
    private readonly insights: InsightService,
    private readonly appState: AppStateService,
  ) {}

  private noteAnalyzer: ((id: string, signal?: AbortSignal) => Promise<number>) | null = null;

  private get sqlite() {
    return this.ctx.database.sqlite;
  }

  /** The analysis of notes (#273) for the retroactive run; returns the number of new proposals. */
  setNoteAnalyzer(fn: (id: string, signal?: AbortSignal) => Promise<number>): void {
    this.noteAnalyzer = fn;
  }

  /** The retroactive run starts again from the first entry (e.g. once after an update that brought new methods). */
  restartBackfill(): void {
    this.appState.set(BACKFILL_CURSOR, '');
  }

  /** Any current or rejected relation between the two (in either direction): no new proposal for them. */
  private connected(a: string, b: string): boolean {
    return Boolean(
      this.sqlite
        .prepare(
          `SELECT 1 FROM relations WHERE ((source_entity_id = ? AND target_entity_id = ?) OR (source_entity_id = ? AND target_entity_id = ?)) AND status IN ('proposed','confirmed','rejected') LIMIT 1`,
        )
        .get(a, b, b, a),
    );
  }

  /** Counts as a knowledge entry for the link methods: not a discarded duplicate, a document only when archived or indexed. */
  isEntry(id: string): boolean {
    return Boolean(this.sqlite.prepare(`SELECT 1 FROM entities e WHERE e.id = ? AND ${ENTRY_SQL('e', LINK_ENTRY_TYPES)}`).get(id));
  }

  private entryText(id: string): string {
    const e = this.graph.getEntity(id);
    return e ? `${e.name} ${e.description ?? ''}`.trim() : '';
  }

  /** Similar indexed entries by their vectors (best first), without the entry itself. */
  private similar(id: string, types: EntityType[], limit: number) {
    return this.search.similarTo(id, { types, limit, minScore: MIN_SIMILARITY });
  }

  /**
   * Link candidates for one entry (#271, #283): similar entries from the search index (the best matching passage as the
   * reason) and topics/projects whose name the entry mentions. Skipped: the entry itself, pairs that are already linked or
   * were rejected, entries discarded as duplicates.
   */
  async candidates(entityId: string, opts: { limit?: number; types?: EntityType[] } = {}): Promise<LinkCandidate[]> {
    const limit = opts.limit ?? 3;
    const self = this.graph.getEntity(entityId);
    if (!self) return [];
    const text = this.entryText(entityId);
    const out = new Map<string, LinkCandidate>();
    for (const h of await this.similar(entityId, opts.types ?? LINK_ENTRY_TYPES, limit * 4)) {
      if (out.has(h.id) || this.connected(entityId, h.id) || !this.isEntry(h.id)) continue;
      const e = this.graph.getEntity(h.id);
      if (!e) continue;
      out.set(h.id, { id: h.id, type: e.type, name: e.name, score: h.score, method: 'similarity', reason: truncate(h.passage.replace(/\s+/g, ' '), 200) });
    }
    // „Das klingt nach Projekt X“: a known topic or project named in the entry
    const words = ` ${normalizeName(text)} `;
    for (const type of ['project', 'topic'] as const)
      for (const s of this.graph.listEntities({ type, limit: 500, confirmedOnly: true })) {
        const n = normalizeName(s.name);
        if (s.id === entityId || n.length < 3 || !words.includes(` ${n} `) || this.connected(entityId, s.id)) continue;
        out.set(s.id, {
          id: s.id,
          type,
          name: s.name,
          score: 0.9,
          method: 'mention',
          reason: `nennt ${type === 'project' ? 'das Projekt' : 'das Thema'} „${s.name}“`,
        });
      }
    return [...out.values()].toSorted((a, b) => b.score - a.score).slice(0, limit);
  }

  private proposalSql(groupBy: 'method' | 'entry') {
    const methods = LINK_PROPOSAL_METHODS.map((m) => `'${m}'`).join(',');
    const types = OWN_FLOW_TYPES.map((t) => `'${t}'`).join(',');
    return {
      from: `FROM relations r JOIN entities s ON s.id = r.source_entity_id JOIN entities t ON t.id = r.target_entity_id
        WHERE r.status = 'proposed' AND r.method IN (${methods}) AND r.relation_type NOT IN (${types})
          AND s.duplicate_of_id IS NULL AND t.duplicate_of_id IS NULL`,
      key: groupBy === 'method' ? 'r.method' : 'r.source_entity_id',
      sort: groupBy === 'method' ? 'r.method' : 's.normalized_name, r.source_entity_id',
    };
  }

  /**
   * Open link proposals for review in one place (#280): grouped by method or by entry, each with its evidence, paged with
   * the total – not capped. Contradictions, versions and duplicates have flows of their own and are not listed.
   */
  proposals(opts: { groupBy?: 'method' | 'entry'; limit?: number; offset?: number } = {}): LinkProposalPage {
    const groupBy = opts.groupBy ?? 'method';
    const q = this.proposalSql(groupBy);
    const groups = (
      this.sqlite
        .prepare(`SELECT ${q.key} AS key, min(s.name) AS name, count(*) AS count ${q.from} GROUP BY ${q.key} ORDER BY min(${q.sort.split(',')[0]}), ${q.key}`)
        .all() as Array<{ key: string; name: string; count: number }>
    ).map((g) => ({ key: g.key, label: groupBy === 'method' ? (RELATION_METHOD_LABELS[g.key as RelationMethod] ?? g.key) : g.name, count: g.count }));
    const rows = this.sqlite
      .prepare(`SELECT r.id AS id, ${q.key} AS groupKey ${q.from} ORDER BY ${q.sort}, r.confidence DESC, r.id LIMIT ? OFFSET ?`)
      .all(opts.limit ?? 50, opts.offset ?? 0) as Array<{ id: string; groupKey: string }>;
    const items = rows.flatMap((row) => {
      const relation = this.graph.getRelation(row.id);
      const s = relation && this.graph.getEntity(relation.sourceEntityId);
      const t = relation && this.graph.getEntity(relation.targetEntityId);
      return relation && s && t
        ? [{ relation, source: { id: s.id, type: s.type, name: s.name }, target: { id: t.id, type: t.type, name: t.name }, groupKey: row.groupKey }]
        : [];
    });
    return { total: groups.reduce((n, g) => n + g.count, 0), groups, items };
  }

  /** Confirms or rejects every open proposal of a group („Alle bestätigen“, #280) – one undo step. */
  decideGroup(groupBy: 'method' | 'entry', key: string, decision: 'confirmed' | 'rejected', opts: { trigger?: string } = {}): number {
    const q = this.proposalSql(groupBy);
    const ids = (this.sqlite.prepare(`SELECT r.id AS id ${q.from} AND ${q.key} = ?`).all(key) as Array<{ id: string }>).map((r) => r.id);
    return this.graph.decideRelations(ids, decision, opts);
  }

  /**
   * Related entries of an entry (#276): direct relations (confirmed and proposed) and indirect connections over shared
   * topics, projects, persons (not the user's own), tags and cases – sorted by strength, each with its reason, paged.
   * Pairs the user rejected and anything that is not an entry (inbox documents, discarded duplicates) are left out.
   */
  related(id: string, opts: { limit?: number; offset?: number } = {}): { total: number; items: RelatedItem[] } {
    const byId = new Map<string, { score: number; relation: GraphRelation | null; shared: RelatedItem['shared'] }>();
    const slot = (other: string) => {
      const s = byId.get(other) ?? { score: 0, relation: null, shared: [] };
      byId.set(other, s);
      return s;
    };
    const rejected = new Set(
      this.graph
        .relationsOf(id, { statuses: ['rejected'] })
        .flatMap((r) => (r.relationType === 'duplicate_of' ? [] : [r.sourceEntityId === id ? r.targetEntityId : r.sourceEntityId])),
    );
    const hubs: Array<{ id: string; type: EntityType; name: string }> = [];
    for (const r of this.graph.relationsOf(id, { statuses: ['proposed', 'confirmed'] })) {
      const otherId = r.sourceEntityId === id ? r.targetEntityId : r.sourceEntityId;
      const other = this.graph.getEntity(otherId);
      if (!other) continue;
      if (SHARED_WEIGHT[other.type] !== undefined) {
        if (!other.isSelf && !hubs.some((h) => h.id === other.id)) hubs.push({ id: other.id, type: other.type, name: other.name });
        continue;
      }
      if (r.relationType === 'duplicate_of' || !LINK_ENTRY_TYPES.includes(other.type)) continue;
      const s = slot(otherId);
      const weight = (r.status === 'confirmed' ? 10 : 5) + r.confidence;
      if (!s.relation || weight > s.score) s.relation = r;
      s.score += weight;
    }
    const members = this.sqlite.prepare(
      `SELECT CASE WHEN r.source_entity_id = ? THEN r.target_entity_id ELSE r.source_entity_id END AS other
       FROM relations r WHERE (r.source_entity_id = ? OR r.target_entity_id = ?) AND r.status IN ('proposed','confirmed')`,
    );
    for (const hub of hubs) {
      const others = [...new Set((members.all(hub.id, hub.id, hub.id) as Array<{ other: string }>).map((m) => m.other))];
      if (others.length > MAX_HUB_MEMBERS) continue;
      for (const other of others) {
        if (other === id) continue;
        const s = slot(other);
        s.score += SHARED_WEIGHT[hub.type] ?? 0;
        s.shared.push(hub);
      }
    }
    const reasonOf = (s: { relation: GraphRelation | null; shared: RelatedItem['shared'] }) => {
      const parts: string[] = [];
      if (s.relation) parts.push(relationReason(s.relation));
      for (const type of SHARED_ORDER) {
        const names = s.shared.filter((h) => h.type === type).map((h) => `„${h.name}“`);
        if (names.length) parts.push(`${SHARED_LABEL[type]} ${names.join(', ')}`);
      }
      return parts.join(' + ');
    };
    const all = [...byId.entries()]
      .filter(([other, s]) => s.score > 0 && !rejected.has(other) && this.isEntry(other))
      .flatMap(([other, s]) => {
        const e = this.graph.getEntity(other);
        return e
          ? [
              {
                entity: { id: e.id, type: e.type, name: e.name, description: e.description },
                score: Math.round(s.score * 100) / 100,
                reason: reasonOf(s),
                relation: s.relation,
                shared: s.shared.toSorted((x, y) => SHARED_ORDER.indexOf(x.type) - SHARED_ORDER.indexOf(y.type) || x.name.localeCompare(y.name, 'de')),
              },
            ]
          : [];
      })
      .toSorted((a, b) => b.score - a.score || a.entity.name.localeCompare(b.entity.name, 'de'));
    const offset = opts.offset ?? 0;
    return { total: all.length, items: all.slice(offset, offset + (opts.limit ?? 10)) };
  }

  /**
   * Entries without any confirmed or proposed relation (#290); a folder (category) alone does not count. Plain SQL, no
   * texts are loaded (#213); paged, with the total.
   */
  orphans(opts: { limit?: number; offset?: number } = {}): OrphanPage {
    const where = `${ENTRY_SQL('e', LINK_ENTRY_TYPES)} AND NOT EXISTS (
      SELECT 1 FROM relations r JOIN entities o ON o.id = CASE WHEN r.source_entity_id = e.id THEN r.target_entity_id ELSE r.source_entity_id END
      WHERE (r.source_entity_id = e.id OR r.target_entity_id = e.id) AND r.status IN ('proposed','confirmed') AND o.type <> 'category')`;
    const total = (this.sqlite.prepare(`SELECT count(*) AS c FROM entities e WHERE ${where}`).get() as { c: number }).c;
    const items = this.sqlite
      .prepare(`SELECT e.id, e.type, e.name, e.created_at AS createdAt FROM entities e WHERE ${where} ORDER BY e.created_at, e.id LIMIT ? OFFSET ?`)
      .all(opts.limit ?? 50, opts.offset ?? 0) as OrphanPage['items'];
    return { total, items };
  }

  /** Entries without a topic and without a project (candidates for a new topic, #281), newest first. */
  private withoutTopic(max: number): Array<{ id: string; type: EntityType; name: string }> {
    return this.sqlite
      .prepare(
        `SELECT e.id, e.type, e.name FROM entities e WHERE ${ENTRY_SQL('e', TOPIC_ENTRY_TYPES)} AND NOT EXISTS (
          SELECT 1 FROM relations r JOIN entities o ON o.id = CASE WHEN r.source_entity_id = e.id THEN r.target_entity_id ELSE r.source_entity_id END
          WHERE (r.source_entity_id = e.id OR r.target_entity_id = e.id) AND r.status IN ('proposed','confirmed') AND o.type IN ('topic','project'))
        ORDER BY e.created_at DESC LIMIT ?`,
      )
      .all(max) as Array<{ id: string; type: EntityType; name: string }>;
  }

  /** Local name suggestion: the words the members' names and descriptions share most. */
  private clusterName(names: string[]): string {
    const counts = new Map<string, number>();
    for (const n of names) for (const t of new Set(tokenize(n).filter((x) => x.length >= 4 && !/^\d+$/.test(x)))) counts.set(t, (counts.get(t) ?? 0) + 1);
    const top = [...counts.entries()]
      .filter(([, c]) => c >= 2)
      .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 2)
      .map(([t]) => t.charAt(0).toUpperCase() + t.slice(1));
    return top.join(' ') || truncate(names[0] ?? 'Neues Thema', 40);
  }

  static clusterKey(ids: string[]): string {
    return createHash('sha1').update(ids.toSorted().join('|')).digest('hex').slice(0, 16);
  }

  /**
   * Groups of similar entries without a topic (#281), from a minimum size on, with a local name suggestion. Groups the user
   * already answered („Nein“ to the proposal) are not offered again.
   */
  async clusters(opts: { minSize?: number; maxEntries?: number; signal?: AbortSignal } = {}): Promise<TopicCluster[]> {
    const minSize = opts.minSize ?? 3;
    const pool = this.withoutTopic(opts.maxEntries ?? 200);
    const ids = new Set(pool.map((p) => p.id));
    const parent = new Map(pool.map((p) => [p.id, p.id]));
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      parent.set(x, r);
      return r;
    };
    for (const p of pool) {
      if (opts.signal?.aborted) break;
      for (const h of await this.similar(p.id, TOPIC_ENTRY_TYPES, 8)) {
        if (!ids.has(h.id) || this.graph.rejectedBetween(p.id, h.id)) continue;
        parent.set(find(h.id), find(p.id));
      }
    }
    const groups = new Map<string, typeof pool>();
    for (const p of pool) groups.set(find(p.id), [...(groups.get(find(p.id)) ?? []), p]);
    return [...groups.values()]
      .filter((g) => g.length >= minSize)
      .map((g) => ({
        key: LinkMethodsService.clusterKey(g.map((m) => m.id)),
        name: this.clusterName(g.map((m) => this.entryText(m.id))),
        members: g,
      }))
      .filter((c) => {
        const answered = this.insights.byDedupeKey(`topic-cluster:${c.key}`);
        return !answered || answered.status === 'open';
      })
      .toSorted((a, b) => b.members.length - a.members.length);
  }

  /**
   * „Neues Thema ‚…‘ anlegen?“ (#281): a hint with the entries as evidence; „Ja“ creates the topic and assigns the entries
   * through the agent's `set_metadata` (one undo step), „Nein“ is remembered. Nothing changes before the user agrees.
   */
  proposeTopic(name: string, memberIds: string[], opts: { conversationId?: string | null } = {}): { insightId: string; actionId: string | null } {
    const members = memberIds.flatMap((id) => {
      const e = this.graph.getEntity(id);
      return e ? [e] : [];
    });
    const key = LinkMethodsService.clusterKey(members.map((m) => m.id));
    const refs = Object.fromEntries(members.map((m, i) => [`K${i + 1}`, m.id]));
    const insight = this.insights.upsert({
      kind: 'topic_cluster',
      title: `Neues Thema „${name}“ anlegen?`,
      explanation: `${members.length} Einträge ohne Thema ähneln sich: ${members
        .slice(0, 6)
        .map((m) => `„${truncate(m.name, 50)}“`)
        .join(', ')}${members.length > 6 ? ' …' : ''}. Mit „Ja“ lege ich das Thema an und ordne sie zu – rückgängig machbar.`,
      confidence: 0.6,
      affected: members.slice(0, 20).map((m) => ({ type: m.type, id: m.id, label: m.name })),
      action: {
        label: 'Thema anlegen',
        proposal: {
          actionType: 'agent_batch',
          label: `Thema „${name}“ anlegen und ${members.length} Einträge zuordnen`,
          rationale: 'Ähnliche Einträge ohne Thema (Archivprüfung).',
          confidence: 0.6,
          affectedEntities: [],
          requiredConfirmation: 'confirm',
          proposedParameters: {
            // inside an agent run the proposal belongs to it (undo of the run covers the assignment)
            runId: currentRun()?.runId ?? newId(),
            ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
            items: [
              {
                tool: 'set_metadata',
                args: { targets: Object.keys(refs), topic: name },
                label: `Thema „${name}“ zuordnen (${members.length} Einträge)`,
                risk: 'write',
                reason: '',
              },
            ],
            refs: { ids: refs, sets: {} },
          },
        },
      },
      dedupeKey: `topic-cluster:${key}`,
    });
    // the user already answered this group („Nein“ or done): no new proposal
    return { insightId: insight.id, actionId: insight.status === 'open' ? (insight.recommendedActionId ?? null) : null };
  }

  /** A current (proposed or confirmed) relation of any type between the two. */
  private linked(a: string, b: string): boolean {
    return Boolean(
      this.sqlite
        .prepare(
          `SELECT 1 FROM relations WHERE ((source_entity_id = ? AND target_entity_id = ?) OR (source_entity_id = ? AND target_entity_id = ?)) AND status IN ('proposed','confirmed') LIMIT 1`,
        )
        .get(a, b, b, a),
    );
  }

  /** Proposes `related_to` with method `co_origin` between the pairs; already linked and rejected pairs are skipped. */
  private proposeTogether(pairs: Array<[string, string]>, evidence: string, sourceIds: string[]): number {
    let created = 0;
    for (const [a, b] of pairs) {
      if (a === b || this.linked(a, b)) continue;
      const r = this.graph.link(a, b, 'related_to', { status: 'proposed', confidence: 0.7, method: 'co_origin', evidence, sourceIds });
      if (r?.created) created += 1;
    }
    return created;
  }

  /**
   * Entries created by the same chat message belong together (#272): each pair is proposed as `related_to` with method
   * `co_origin` and the message as evidence (more than {@link MAX_PAIRWISE} entries: in a chain, in the order they were
   * created). Entries removed meanwhile are skipped. Returns the number of new proposals.
   */
  linkCreatedTogether(entries: CreatedEntry[], opts: { evidence: string; sourceIds?: string[] }): number {
    const ids = [...new Set(entries.map((e) => e.id))].filter((id) => this.graph.getEntity(id));
    if (ids.length < 2) return 0;
    const pairs: Array<[string, string]> =
      ids.length <= MAX_PAIRWISE ? ids.flatMap((a, i) => ids.slice(i + 1).map((b): [string, string] => [a, b])) : ids.slice(1).map((b, i) => [ids[i]!, b]);
    return this.proposeTogether(pairs, opts.evidence, opts.sourceIds ?? []);
  }

  /**
   * Entries extracted from the same document belong together (#272): a new decision, open item or event that names a
   * document as its source is proposed as `related_to` (`co_origin`) with the other entries from that document.
   */
  linkSameDocument(entryId: string): number {
    const docs = new Set<string>();
    for (const t of SOURCE_TABLES) {
      const rows = this.sqlite.prepare(`SELECT j.value AS doc FROM ${t} r, json_each(r.source_ids) j WHERE r.id = ?`).all(entryId) as Array<{ doc: string }>;
      for (const r of rows) docs.add(r.doc);
    }
    let created = 0;
    for (const doc of docs) {
      const d = this.graph.getEntity(doc);
      if (d?.type !== 'document') continue;
      const others = SOURCE_TABLES.flatMap(
        (t) =>
          this.sqlite
            .prepare(
              `SELECT r.id FROM ${t} r WHERE r.id <> ? AND EXISTS (SELECT 1 FROM json_each(r.source_ids) j WHERE j.value = ?)${t === 'decisions' ? '' : ' AND r.duplicate_of_id IS NULL'}`,
            )
            .all(entryId, doc) as Array<{ id: string }>,
      ).map((r) => r.id);
      created += this.proposeTogether(
        others.map((o): [string, string] => [entryId, o]),
        `Beide stammen aus dem Dokument „${truncate(d.name, 80)}“.`,
        [doc],
      );
    }
    return created;
  }

  /** Local day of the entry's business date, or null (#278). */
  private businessDay(id: string): string | null {
    for (const b of BUSINESS_DATE) {
      const row = this.sqlite.prepare(`SELECT x.${b.column} AS d FROM ${b.table} x WHERE x.id = ? ${b.extra ?? ''}`).get(id) as
        { d: string | null } | undefined;
      if (row) return row.d ? localDate(row.d) : null;
    }
    return null;
  }

  /** Persons connected to the entry by a current relation – without the user's own person. */
  private personsOf(id: string): Map<string, string> {
    const rows = this.sqlite
      .prepare(
        `SELECT p.id, p.name FROM relations r JOIN entities p ON p.id = CASE WHEN r.source_entity_id = ? THEN r.target_entity_id ELSE r.source_entity_id END
         WHERE (r.source_entity_id = ? OR r.target_entity_id = ?) AND r.status IN ('proposed','confirmed') AND p.type = 'person' AND p.is_self = 0`,
      )
      .all(id, id, id) as Array<{ id: string; name: string }>;
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  /**
   * Events, decisions and documents of the same day with at least one shared person belong together (#278): proposed as
   * `related_to` with method `date_person`, the evidence names the day and the persons. The day is the business date in
   * local time; the user's own person alone is no reason. Rejected and already linked pairs are skipped.
   */
  proposeSameDayPerson(id: string): number {
    const day = this.businessDay(id);
    if (!day) return 0;
    const persons = this.personsOf(id);
    if (!persons.size) return 0;
    let created = 0;
    for (const b of BUSINESS_DATE) {
      // stored instants can fall on a neighbouring UTC day: take one day around and compare the local day
      const rows = this.sqlite
        .prepare(`SELECT x.id, x.${b.column} AS d FROM ${b.table} x WHERE x.id <> ? AND substr(x.${b.column}, 1, 10) BETWEEN ? AND ? ${b.extra ?? ''}`)
        .all(id, dayShift(day, -1), dayShift(day, 1)) as Array<{ id: string; d: string }>;
      for (const row of rows) {
        if (localDate(row.d) !== day || this.linked(id, row.id) || !this.graph.getEntity(row.id)) continue;
        const shared = [...this.personsOf(row.id).entries()].filter(([pid]) => persons.has(pid)).map(([, name]) => `„${name}“`);
        if (!shared.length) continue;
        const r = this.graph.link(id, row.id, 'related_to', {
          status: 'proposed',
          confidence: 0.6,
          method: 'date_person',
          evidence: `Am ${germanDay(day)} mit ${shared.join(', ')}`,
        });
        if (r?.created) created += 1;
      }
    }
    return created;
  }

  /** Open similarity proposals of an entry (either direction). */
  private openSimilarityProposals(id: string): number {
    return (
      this.sqlite
        .prepare(`SELECT count(*) AS c FROM relations WHERE (source_entity_id = ? OR target_entity_id = ?) AND status = 'proposed' AND method = 'similarity'`)
        .get(id, id) as { c: number }
    ).c;
  }

  /**
   * Proposes similar entries of one entry as `related_to` (#271): status proposed, method `similarity`, the most similar
   * passage as evidence. At most `max` open proposals per entry – on both ends; skipped are pairs that are already linked
   * (also as duplicate or version) or were rejected, and anything that is not an entry (inbox documents, duplicates).
   * Quiet: proposals change nothing, so they are not logged one by one. Returns the number of new proposals.
   */
  async proposeSimilar(id: string, opts: { max?: number } = {}): Promise<number> {
    const max = opts.max ?? MAX_SIMILAR_PROPOSALS;
    if (!this.isEntry(id)) return 0;
    let room = max - this.openSimilarityProposals(id);
    if (room <= 0) return 0;
    let created = 0;
    for (const c of await this.candidates(id, { limit: max * 2 })) {
      if (room <= 0) break;
      if (c.method !== 'similarity' || this.openSimilarityProposals(c.id) >= max) continue;
      const r = this.graph.link(id, c.id, 'related_to', { status: 'proposed', confidence: c.score, method: 'similarity', evidence: c.reason });
      if (r?.created) {
        created += 1;
        room -= 1;
      }
    }
    return created;
  }

  /** Remembers entries to look for similar ones (after indexing, #271); returns true if one of them counts. */
  queueSimilar(ids: string[]): boolean {
    const wanted = ids.filter((id) => this.isEntry(id));
    if (!wanted.length) return false;
    const pending = new Set(this.pendingSimilar());
    for (const id of wanted) pending.add(id);
    this.appState.set(SIMILAR_PENDING, JSON.stringify([...pending]));
    return true;
  }

  private pendingSimilar(): string[] {
    try {
      const v = JSON.parse(this.appState.get(SIMILAR_PENDING) ?? '[]') as unknown;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  /**
   * Works through the remembered entries (job `links.similar`): each one is removed from the list only once done, so a
   * stopped or interrupted pass continues with the rest. Entries queued meanwhile are taken in the same pass.
   */
  async runPendingSimilar(opts: { max?: number; signal?: AbortSignal } = {}): Promise<{ processed: number; proposed: number }> {
    let processed = 0;
    let proposed = 0;
    for (let next = this.pendingSimilar()[0]; next !== undefined; next = this.pendingSimilar()[0]) {
      if (opts.signal?.aborted) break;
      try {
        // the more specific reason first: same day and person (#278), then similar content (#271)
        proposed += this.proposeSameDayPerson(next);
        proposed += await this.proposeSimilar(next, { max: opts.max });
      } catch (err) {
        this.ctx.logger.warn('links', 'Similarity proposals skipped', { error: err, id: next });
      }
      this.appState.set(SIMILAR_PENDING, JSON.stringify(this.pendingSimilar().filter((x) => x !== next)));
      processed += 1;
    }
    return { processed, proposed };
  }

  /**
   * Retroactive link run (#279): goes through all entries in a stable order and PROPOSES `related_to` for each with its
   * similar entries, same-day entries with a shared person and entries from the same document, and analyses notes. The position is stored after every entry – a stopped or interrupted run continues where it was and pays for
   * nothing twice. Returns when `maxEntries` are done, the signal aborts or everything is done.
   */
  async backfill(opts: { maxEntries?: number; signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}): Promise<BackfillResult> {
    const max = opts.maxEntries ?? 200;
    const cursor = this.appState.get(BACKFILL_CURSOR) ?? '';
    const where = ENTRY_SQL('e', LINK_ENTRY_TYPES);
    const rows = this.sqlite.prepare(`SELECT e.id FROM entities e WHERE ${where} AND e.id > ? ORDER BY e.id LIMIT ?`).all(cursor, max) as Array<{ id: string }>;
    let processed = 0;
    let proposed = 0;
    for (const { id } of rows) {
      if (opts.signal?.aborted) break;
      for (const c of await this.candidates(id, { limit: 3, types: LINK_ENTRY_TYPES })) {
        if (c.method !== 'similarity' || this.graph.rejectedBetween(id, c.id)) continue;
        try {
          const r = this.graph.linkEntries(id, c.id, 'related_to', {
            status: 'proposed',
            trigger: 'link_backfill',
            confidence: c.score,
            origin: 'system',
            method: 'similarity',
            evidence: c.reason,
          });
          if (r.created) proposed += 1;
        } catch (err) {
          // e.g. an entry removed meanwhile: this pair is skipped, the run goes on
          this.ctx.logger.warn('links', 'Link proposal skipped', { error: err, from: id, to: c.id });
        }
      }
      // the other methods of Epic #269: same day and person, same source document, the analysis of a note (#279)
      try {
        proposed += this.proposeSameDayPerson(id);
        proposed += this.linkSameDocument(id);
        if (this.noteAnalyzer && this.graph.getEntity(id)?.type === 'note') proposed += await this.noteAnalyzer(id, opts.signal);
      } catch (err) {
        this.ctx.logger.warn('links', 'Link methods skipped for an entry', { error: err, id });
      }
      // stopped in the middle of this entry: it is done again next time (nothing finished is paid twice)
      if (opts.signal?.aborted) break;
      processed += 1;
      this.appState.set(BACKFILL_CURSOR, id);
      opts.onProgress?.(processed, rows.length);
    }
    const remaining = (
      this.sqlite.prepare(`SELECT count(*) AS c FROM entities e WHERE ${where} AND e.id > ?`).get(this.appState.get(BACKFILL_CURSOR) ?? '') as { c: number }
    ).c;
    const done = remaining === 0;
    // finished: the next run starts over (new entries since then get their chance)
    if (done) this.appState.set(BACKFILL_CURSOR, '');
    return { processed, proposed, done, remaining };
  }
}
