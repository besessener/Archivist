import type { EntityType, GraphEntity } from '@archivist/shared';
import type { AppContext } from '../context';
import { CREATED_UNDO_TYPE, type CreatedUndoData } from '../agent/created-undo';
import { AppError } from '../util/errors';
import type { AuditService } from './audit';
import type { KnowledgeGraphService } from './knowledge-graph';

/** Kinds of entries a case collects (#286). */
const CASE_ENTRY_TYPES: EntityType[] = ['document', 'note', 'decision', 'task', 'question', 'event'];
const OPEN_ITEM_STATUSES = ['open', 'waiting', 'blocked'];
const isOpenItem = (entry: { status: string | null }) => entry.status !== null && OPEN_ITEM_STATUSES.includes(entry.status);

export interface CaseSummary {
  id: string;
  name: string;
  description: string | null;
  status: 'open' | 'closed';
  entries: number;
  openItems: number;
  updatedAt: string;
}

export interface CaseEntry {
  id: string;
  type: EntityType;
  name: string;
  /** The entry's own date (event, decision, document date, due date) or when it was captured – for the timeline. */
  date: string | null;
  /** Status of an open item (open, waiting, blocked, resolved …). */
  status: string | null;
  /** The assignment is only proposed (by a link method), not confirmed yet. */
  proposed: boolean;
  relationId: string;
}

export type CaseServiceDeps = { ctx: AppContext; graph: KnowledgeGraphService; audit: AuditService };

/** Cases („Vorgänge“, #286): graph nodes collecting the entries of one matter over `belongs_to`; every change is undoable. */
export class CaseService {
  private readonly ctx: AppContext;
  private readonly graph: KnowledgeGraphService;
  private readonly audit: AuditService;

  constructor(deps: CaseServiceDeps) {
    ({ ctx: this.ctx, graph: this.graph, audit: this.audit } = deps);
  }

  private get sqlite() {
    return this.ctx.database.sqlite;
  }

  private caseOf(id: string): GraphEntity {
    const found = this.graph.getEntity(id);
    if (found?.type !== 'case') throw new AppError('validation_error', 'Vorgang nicht gefunden.');
    return found;
  }

  /** Entries of a case: current assignments (confirmed and proposed), without discarded duplicates and inbox documents. */
  entries(caseId: string): CaseEntry[] {
    this.caseOf(caseId);
    const types = CASE_ENTRY_TYPES.map((t) => `'${t}'`).join(',');
    return this.sqlite
      .prepare(
        `SELECT e.id, e.type, e.name, r.status AS relStatus, r.id AS relationId,
           COALESCE(ev.occurred_at, d.decided_at, doc.document_date, oi.due_at, doc.archived_at, e.created_at) AS date,
           oi.status AS status
         FROM relations r
         JOIN entities e ON e.id = CASE WHEN r.target_entity_id = ? THEN r.source_entity_id ELSE r.target_entity_id END
         LEFT JOIN events ev ON ev.id = e.id
         LEFT JOIN decisions d ON d.id = e.id
         LEFT JOIN documents doc ON doc.id = e.id
         LEFT JOIN open_items oi ON oi.id = e.id
         WHERE (r.source_entity_id = ? OR r.target_entity_id = ?) AND r.status IN ('proposed','confirmed') AND e.type IN (${types})
           AND e.duplicate_of_id IS NULL AND (e.type <> 'document' OR doc.status IN ('archived','indexed_only'))
         ORDER BY date DESC, e.name`,
      )
      .all(caseId, caseId, caseId)
      .map((result) => {
        const row = result as { id: string; type: EntityType; name: string; relStatus: string; relationId: string; date: string | null; status: string | null };
        return {
          id: row.id,
          type: row.type,
          name: row.name,
          date: row.date,
          status: row.status,
          proposed: row.relStatus === 'proposed',
          relationId: row.relationId,
        };
      })
      .filter((entry, index, all) => all.findIndex((x) => x.id === entry.id) === index);
  }

  list(opts: { includeClosed?: boolean } = {}): CaseSummary[] {
    return this.graph
      .listEntities({ type: 'case', limit: 1000 })
      .filter((found) => opts.includeClosed !== false || found.status !== 'closed')
      .map((found) => {
        const entries = this.entries(found.id).filter((entry) => !entry.proposed);
        return {
          id: found.id,
          name: found.name,
          description: found.description,
          status: found.status === 'closed' ? ('closed' as const) : ('open' as const),
          entries: entries.length,
          openItems: entries.filter(isOpenItem).length,
          updatedAt: found.updatedAt,
        };
      })
      .toSorted((a, b) => Number(a.status === 'closed') - Number(b.status === 'closed') || a.name.localeCompare(b.name, 'de'));
  }

  /** The page of a case: its entries (newest first, for the timeline) and its open items. */
  detail(caseId: string): { case: GraphEntity; entries: CaseEntry[]; openItems: CaseEntry[] } {
    const found = this.caseOf(caseId);
    const entries = this.entries(caseId);
    return { case: found, entries, openItems: entries.filter(isOpenItem) };
  }

  /** A new case (or the existing one of that name or alias); creating is undoable. */
  create({ name, description, ...opts }: { name: string; description?: string | null; trigger?: string }): { case: GraphEntity; created: boolean } {
    const clean = name.trim().replace(/\s+/g, ' ');
    if (!clean) throw new AppError('validation_error', 'Ein Vorgang braucht einen Namen.');
    const existing = this.graph.findByNameOrAlias('case', clean);
    if (existing) return { case: existing, created: false };
    const created = this.graph.ensureEntity({ type: 'case', name: clean, description: description?.trim() || null });
    this.audit.log({
      action: 'case.create',
      actor: 'user',
      trigger: opts.trigger ?? 'manual',
      confirmed: true,
      entityIds: [created.id],
      after: { name: created.name },
      undo: { type: CREATED_UNDO_TYPE, data: { action: 'case.create', id: created.id } satisfies CreatedUndoData },
    });
    return { case: created, created: true };
  }

  /** Puts entries into a case – ONE undo step for all of them (#286, #291). */
  assign({ entryIds, caseId, ...opts }: { entryIds: string[]; caseId: string; trigger?: string }): number {
    const target = this.caseOf(caseId);
    const ids = entryIds.filter((id) => {
      const entry = this.graph.getEntity(id);
      return entry && CASE_ENTRY_TYPES.includes(entry.type);
    });
    if (!ids.length) throw new AppError('validation_error', 'Keine passenden Einträge für einen Vorgang ausgewählt.');
    return this.graph.linkMany({ sourceIds: ids, targetId: target.id, relationType: 'belongs_to' }, { trigger: opts.trigger, action: 'case.assign' });
  }
}
