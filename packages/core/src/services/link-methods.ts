import { createHash } from 'node:crypto';
import type { EntityType } from '@archivist/shared';
import type { AppContext } from '../context';
import { currentRun } from '../agent/scope';
import { newId } from '../util/ids';
import { normalizeName, tokenize, truncate } from '../util/text';
import type { AppStateService } from './app-state';
import type { InsightService } from './insights';
import type { KnowledgeGraphService } from './knowledge-graph';
import type { SearchService } from './search';

/** Knowledge entries the link methods connect (documents only once archived or indexed). */
export const LINK_ENTRY_TYPES: EntityType[] = ['document', 'note', 'decision', 'task', 'question', 'event'];
/** Entries a topic can be assigned to with the same function as in the UI (`set_metadata` / bulk assignment). */
const TOPIC_ENTRY_TYPES: EntityType[] = ['document', 'decision', 'task', 'question', 'event'];

/**
 * Minimum cosine similarity of two entries' chunk vectors for a proposal (#271). The local hash vectors are lexical: texts
 * of the archive share words and headers, so unrelated entries still reach about 0.4 – their bar is higher than that of
 * real embeddings.
 */
export const MIN_SIMILARITY = { local: 0.5, embeddings: 0.6 };

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

  private get sqlite() {
    return this.ctx.database.sqlite;
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
      if (out.has(h.id) || this.connected(entityId, h.id)) continue;
      const e = this.graph.getEntity(h.id);
      if (!e || e.duplicateOfId) continue;
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

  /**
   * Retroactive link run (#279): goes through all entries in a stable order and PROPOSES `related_to` for each with its
   * candidates. The position is stored after every entry – a stopped or interrupted run continues where it was and pays for
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
          const r = this.graph.linkEntries(id, c.id, 'related_to', { status: 'proposed', trigger: 'link_backfill', confidence: c.score, origin: 'system' });
          if (r.created) proposed += 1;
        } catch (err) {
          // e.g. an entry removed meanwhile: this pair is skipped, the run goes on
          this.ctx.logger.warn('links', 'Link proposal skipped', { error: err, from: id, to: c.id });
        }
      }
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
