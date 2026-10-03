import type { EntityType } from '@archivist/shared';
import { relationTypeFor, type LinkCandidate, type LinkCandidates } from './candidates';
import { entrySql, isEntry, LINK_ENTRY_TYPES, type LinkDeps } from './entries';

export interface OrphanPage {
  total: number;
  items: Array<{ id: string; type: EntityType; name: string; createdAt: string }>;
}

/** Where the orphan check of the archive check continues (#290). */
const ORPHAN_CURSOR = 'links.orphans.cursor';
/** The one bundled hint about entries without a link (#290). */
export const ORPHAN_INSIGHT = 'orphan-entries';

/** Entries without any confirmed or proposed relation (#290); a folder (category) alone does not count. */
const ORPHAN_WHERE = `${entrySql('e', LINK_ENTRY_TYPES)} AND NOT EXISTS (
      SELECT 1 FROM relations r JOIN entities o ON o.id = CASE WHEN r.source_entity_id = e.id THEN r.target_entity_id ELSE r.source_entity_id END
      WHERE (r.source_entity_id = e.id OR r.target_entity_id = e.id) AND r.status IN ('proposed','confirmed') AND o.type <> 'category')`;

/** Relation of the entry with the status to anything but a folder. */
const LINK_TO_NON_FOLDER = (status: 'confirmed' | 'proposed') =>
  `SELECT 1 FROM relations r JOIN entities o ON o.id = CASE WHEN r.source_entity_id = ? THEN r.target_entity_id ELSE r.source_entity_id END
           WHERE (r.source_entity_id = ? OR r.target_entity_id = ?) AND r.status = '${status}' AND o.type <> 'category' LIMIT 1`;

/** The bundled hint text: who has targets in the proposal list, who still needs a link by hand. */
function orphanExplanation(counts: { withTargets: number; rest: number }): string {
  const { withTargets, rest } = counts;
  return [
    withTargets
      ? `Für ${withTargets === 1 ? 'einen davon' : `${withTargets} davon`} gibt es passende Ziele – du findest sie oben unter „Verknüpfungsvorschläge“.`
      : null,
    rest
      ? `${rest === 1 ? 'Einer hat' : `${rest} haben`} noch kein passendes Ziel; verknüpfe ${rest === 1 ? 'ihn' : 'sie'} in der Detailansicht unter „Verwandte Einträge“.`
      : null,
    'Der Hinweis schließt sich, sobald jeder dieser Einträge eine bestätigte Verknüpfung hat.',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Entries without any link (#290): the list and the archive check step that proposes targets for them. */
export class OrphanLinks {
  constructor(
    private readonly deps: LinkDeps,
    private readonly candidates: LinkCandidates,
  ) {}

  private get sqlite() {
    return this.deps.ctx.database.sqlite;
  }

  /** Plain SQL, no texts are loaded (#213); paged, with the total. */
  orphans(page: { limit?: number; offset?: number } = {}): OrphanPage {
    const total = (this.sqlite.prepare(`SELECT count(*) AS c FROM entities e WHERE ${ORPHAN_WHERE}`).get() as { c: number }).c;
    const items = this.sqlite
      .prepare(`SELECT e.id, e.type, e.name, e.created_at AS createdAt FROM entities e WHERE ${ORPHAN_WHERE} ORDER BY e.created_at, e.id LIMIT ? OFFSET ?`)
      .all(page.limit ?? 50, page.offset ?? 0) as OrphanPage['items'];
    return { total, items };
  }

  private hasLink(id: string, status: 'confirmed' | 'proposed'): boolean {
    return Boolean(this.sqlite.prepare(LINK_TO_NON_FOLDER(status)).get(id, id, id));
  }

  /** Proposes up to two targets per orphan, continuing where the last run stopped, and keeps ONE bundled hint up to date. */
  async checkOrphans(options: { propose?: boolean; maxEntries?: number; signal?: AbortSignal } = {}): Promise<{ pending: number; proposed: number }> {
    const orphanIds = (this.sqlite.prepare(`SELECT e.id FROM entities e WHERE ${ORPHAN_WHERE} ORDER BY e.id`).all() as Array<{ id: string }>).map(
      (row) => row.id,
    );
    const proposed = options.propose !== false && orphanIds.length ? await this.proposeTargets(orphanIds, options) : 0;
    const previous = this.deps.insights.byDedupeKey(ORPHAN_INSIGHT)?.sourceIds ?? [];
    const pending = [...new Set([...orphanIds, ...previous])].filter((id) => isEntry(this.sqlite, id) && !this.hasLink(id, 'confirmed'));
    if (!pending.length) {
      this.deps.insights.reconcile(ORPHAN_INSIGHT, new Set());
      return { pending: 0, proposed };
    }
    this.upsertHint(pending);
    return { pending: pending.length, proposed };
  }

  /** At most `maxEntries` per run in a stable order, so entries without a target do not block the others. */
  private async proposeTargets(orphanIds: string[], options: { maxEntries?: number; signal?: AbortSignal }): Promise<number> {
    const cursor = this.deps.appState.get(ORPHAN_CURSOR) ?? '';
    const batch = [...orphanIds.filter((id) => id > cursor), ...orphanIds.filter((id) => id <= cursor)].slice(0, options.maxEntries ?? 50);
    let proposed = 0;
    for (const id of batch) {
      if (options.signal?.aborted) break;
      try {
        for (const candidate of await this.candidates.candidates(id, { limit: 2 })) if (this.propose(id, candidate)) proposed += 1;
      } catch (err) {
        this.deps.ctx.logger.warn('links', 'Targets for an entry without links skipped', { error: err, id });
      }
      this.deps.appState.set(ORPHAN_CURSOR, id);
    }
    return proposed;
  }

  /** Stores the candidate as a proposal; true if it is new. */
  private propose(id: string, candidate: LinkCandidate): boolean {
    const result = this.deps.graph.link(
      { sourceId: id, targetId: candidate.id, relationType: relationTypeFor(candidate) },
      {
        status: 'proposed',
        confidence: candidate.score,
        method: candidate.method,
        evidence: candidate.reason,
      },
    );
    return result?.created ?? false;
  }

  private upsertHint(pending: string[]): void {
    const withTargets = pending.filter((id) => this.hasLink(id, 'proposed')).length;
    const shown = pending.slice(0, 15).flatMap((id) => {
      const entity = this.deps.graph.getEntity(id);
      return entity ? [{ type: entity.type, id: entity.id, label: entity.name }] : [];
    });
    this.deps.insights.upsert({
      kind: 'orphan_entries',
      title: `${pending.length} ${pending.length === 1 ? 'Eintrag' : 'Einträge'} ohne Verknüpfung`,
      explanation: orphanExplanation({ withTargets, rest: pending.length - withTargets }),
      confidence: 0.7,
      affected: shown,
      sourceIds: pending,
      dedupeKey: ORPHAN_INSIGHT,
    });
  }
}
