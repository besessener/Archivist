import { createHash } from 'node:crypto';
import type { EntityType, GraphEntity } from '@archivist/shared';
import { currentRun } from '../../agent/scope';
import { newId } from '../../util/ids';
import { tokenize, truncate } from '../../util/text';
import type { LinkCandidates } from './candidates';
import { entrySql, TOPIC_ENTRY_TYPES, type LinkDeps } from './entries';

export interface TopicCluster {
  /** Stable for the same members: a rejected proposal („Nein“) is remembered under it. */
  key: string;
  name: string;
  members: Array<{ id: string; type: EntityType; name: string }>;
}

export type TopicNamer = (cluster: TopicCluster, signal?: AbortSignal) => Promise<string | null>;

type Member = TopicCluster['members'][number];

const clusterKey = (ids: string[]): string => createHash('sha1').update(ids.toSorted().join('|')).digest('hex').slice(0, 16);
const dedupeKeyOf = (key: string) => `topic-cluster:${key}`;

/** Local name suggestion: the words the members' names and descriptions share most. */
function clusterName(texts: string[]): string {
  const counts = new Map<string, number>();
  for (const text of texts)
    for (const token of new Set(tokenize(text).filter((word) => word.length >= 4 && !/^\d+$/.test(word)))) counts.set(token, (counts.get(token) ?? 0) + 1);
  const top = [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 2)
    .map(([token]) => token.charAt(0).toUpperCase() + token.slice(1));
  return top.join(' ') || truncate(texts[0] ?? 'Neues Thema', 40);
}

/** Union-find over entry ids. */
class Groups {
  private readonly parent: Map<string, string>;

  constructor(ids: string[]) {
    this.parent = new Map(ids.map((id) => [id, id]));
  }

  root(id: string): string {
    let root = id;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    this.parent.set(id, root);
    return root;
  }

  join(a: string, b: string): void {
    this.parent.set(this.root(a), this.root(b));
  }
}

function explanationOf(members: GraphEntity[]): string {
  const names = members
    .slice(0, 6)
    .map((member) => `„${truncate(member.name, 50)}“`)
    .join(', ');
  return `${members.length} Einträge ohne Thema ähneln sich: ${names}${members.length > 6 ? ' …' : ''}. Mit „Ja“ lege ich das Thema an und ordne sie zu – rückgängig machbar.`;
}

/** Groups of similar entries without a topic as a proposal for a new topic (#281). */
export class TopicClusters {
  private namer: TopicNamer = async () => null;

  constructor(
    private readonly deps: LinkDeps,
    private readonly candidates: LinkCandidates,
  ) {}

  setNamer(namer: TopicNamer): void {
    this.namer = namer;
  }

  /** Proposes each new group as a topic; open proposals stay as they are, answered groups do not come back. */
  async proposeClusterTopics(options: { signal?: AbortSignal } = {}): Promise<number> {
    let proposed = 0;
    for (const cluster of await this.clusters({ signal: options.signal })) {
      if (options.signal?.aborted) break;
      if (this.deps.insights.byDedupeKey(dedupeKeyOf(cluster.key))?.status === 'open') continue;
      const name = (await this.namer(cluster, options.signal)) ?? cluster.name;
      const memberIds = cluster.members.map((member) => member.id);
      if (this.proposeTopic({ name, memberIds }, {}).actionId) proposed += 1;
    }
    return proposed;
  }

  /** Entries without a topic and without a project (candidates for a new topic), newest first. */
  private withoutTopic(max: number): Member[] {
    return this.deps.ctx.database.sqlite
      .prepare(
        `SELECT e.id, e.type, e.name FROM entities e WHERE ${entrySql('e', TOPIC_ENTRY_TYPES)} AND NOT EXISTS (
          SELECT 1 FROM relations r JOIN entities o ON o.id = CASE WHEN r.source_entity_id = e.id THEN r.target_entity_id ELSE r.source_entity_id END
          WHERE (r.source_entity_id = e.id OR r.target_entity_id = e.id) AND r.status IN ('proposed','confirmed') AND o.type IN ('topic','project'))
        ORDER BY e.created_at DESC LIMIT ?`,
      )
      .all(max) as Member[];
  }

  /** Groups from a minimum size on, with a local name suggestion; groups the user already answered are not offered again. */
  async clusters(options: { minSize?: number; maxEntries?: number; signal?: AbortSignal } = {}): Promise<TopicCluster[]> {
    const pool = this.withoutTopic(options.maxEntries ?? 200);
    const groups = await this.group(pool, options.signal);
    const byRoot = new Map<string, Member[]>();
    for (const member of pool) byRoot.set(groups.root(member.id), [...(byRoot.get(groups.root(member.id)) ?? []), member]);
    return [...byRoot.values()]
      .filter((members) => members.length >= (options.minSize ?? 3))
      .map((members) => ({
        key: clusterKey(members.map((member) => member.id)),
        name: clusterName(members.map((member) => this.candidates.entryText(member.id))),
        members,
      }))
      .filter((cluster) => {
        const answered = this.deps.insights.byDedupeKey(dedupeKeyOf(cluster.key));
        return !answered || answered.status === 'open';
      })
      .toSorted((a, b) => b.members.length - a.members.length);
  }

  private async group(pool: Member[], signal: AbortSignal | undefined): Promise<Groups> {
    const ids = new Set(pool.map((member) => member.id));
    const groups = new Groups([...ids]);
    for (const member of pool) {
      if (signal?.aborted) break;
      for (const hit of await this.candidates.similar({ id: member.id, types: TOPIC_ENTRY_TYPES, limit: 8, learned: false })) {
        if (!ids.has(hit.id) || this.deps.graph.rejectedBetween(member.id, hit.id)) continue;
        groups.join(hit.id, member.id);
      }
    }
    return groups;
  }

  /** „Neues Thema ‚…‘ anlegen?“ as a hint whose „Ja“ assigns the entries via `set_metadata` (one undo step); nothing changes before. */
  proposeTopic(topic: { name: string; memberIds: string[] }, options: { conversationId?: string | null }): { insightId: string; actionId: string | null } {
    const { name } = topic;
    const members = topic.memberIds.flatMap((id) => {
      const entity = this.deps.graph.getEntity(id);
      return entity ? [entity] : [];
    });
    const refs = Object.fromEntries(members.map((member, index) => [`K${index + 1}`, member.id]));
    const insight = this.deps.insights.upsert({
      kind: 'topic_cluster',
      title: `Neues Thema „${name}“ anlegen?`,
      explanation: explanationOf(members),
      confidence: 0.6,
      affected: members.slice(0, 20).map((member) => ({ type: member.type, id: member.id, label: member.name })),
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
            ...(options.conversationId ? { conversationId: options.conversationId } : {}),
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
      dedupeKey: dedupeKeyOf(clusterKey(members.map((member) => member.id))),
    });
    // the user already answered this group („Nein“ or done): no new proposal
    return { insightId: insight.id, actionId: insight.status === 'open' ? (insight.recommendedActionId ?? null) : null };
  }
}
