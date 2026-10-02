import type { EntityType, GraphEntity } from '@archivist/shared';
import type { AppContext } from '../context';
import { CREATED_UNDO_TYPE, type CreatedUndoData } from '../agent/created-undo';
import { AppError } from '../util/errors';
import type { AuditService } from './audit';
import type { KnowledgeGraphService } from './knowledge-graph';

/** Kinds of entries a case collects (#286). */
const CASE_ENTRY_TYPES: EntityType[] = ['document', 'note', 'decision', 'task', 'question', 'event'];
const OPEN_ITEM_STATUSES = ['open', 'waiting', 'blocked'];

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

/**
 * Cases („Vorgänge“, #286): a collection of the documents, decisions, open items, events and notes that belong to one
 * matter – „Steuererklärung 2025“, „Autokauf“. A case is a node of the knowledge graph; an entry belongs to it over a
 * `belongs_to` relation and can belong to several cases. Creating, assigning and closing are undoable.
 */
export class CaseService {
  constructor(
    private readonly ctx: AppContext,
    private readonly graph: KnowledgeGraphService,
    private readonly audit: AuditService,
  ) {}

  private get sqlite() {
    return this.ctx.database.sqlite;
  }

  private caseOf(id: string): GraphEntity {
    const c = this.graph.getEntity(id);
    if (c?.type !== 'case') throw new AppError('validation_error', 'Vorgang nicht gefunden.');
    return c;
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
      .map((r) => {
        const row = r as { id: string; type: EntityType; name: string; relStatus: string; relationId: string; date: string | null; status: string | null };
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
      .filter((e, i, all) => all.findIndex((x) => x.id === e.id) === i);
  }

  list(opts: { includeClosed?: boolean } = {}): CaseSummary[] {
    return this.graph
      .listEntities({ type: 'case', limit: 1000 })
      .filter((c) => opts.includeClosed !== false || c.status !== 'closed')
      .map((c) => {
        const entries = this.entries(c.id).filter((e) => !e.proposed);
        return {
          id: c.id,
          name: c.name,
          description: c.description,
          status: c.status === 'closed' ? ('closed' as const) : ('open' as const),
          entries: entries.length,
          openItems: entries.filter((e) => e.status && OPEN_ITEM_STATUSES.includes(e.status)).length,
          updatedAt: c.updatedAt,
        };
      })
      .toSorted((a, b) => Number(a.status === 'closed') - Number(b.status === 'closed') || a.name.localeCompare(b.name, 'de'));
  }

  /** The page of a case: its entries (newest first, for the timeline) and its open items. */
  detail(caseId: string): { case: GraphEntity; entries: CaseEntry[]; openItems: CaseEntry[] } {
    const c = this.caseOf(caseId);
    const entries = this.entries(caseId);
    return { case: c, entries, openItems: entries.filter((e) => e.status && OPEN_ITEM_STATUSES.includes(e.status)) };
  }

  /** A new case (or the existing one of that name or alias); creating is undoable. */
  create(name: string, description?: string | null, opts: { trigger?: string } = {}): { case: GraphEntity; created: boolean } {
    const clean = name.trim().replace(/\s+/g, ' ');
    if (!clean) throw new AppError('validation_error', 'Ein Vorgang braucht einen Namen.');
    const existing = this.graph.findByNameOrAlias('case', clean);
    if (existing) return { case: existing, created: false };
    const c = this.graph.ensureEntity('case', clean, description?.trim() || null);
    this.audit.log({
      action: 'case.create',
      actor: 'user',
      trigger: opts.trigger ?? 'manual',
      confirmed: true,
      entityIds: [c.id],
      after: { name: c.name },
      undo: { type: CREATED_UNDO_TYPE, data: { action: 'case.create', id: c.id } satisfies CreatedUndoData },
    });
    return { case: c, created: true };
  }

  /** Puts entries into a case – ONE undo step for all of them (#286, #291). */
  assign(entryIds: string[], caseId: string, opts: { trigger?: string } = {}): number {
    const c = this.caseOf(caseId);
    const ids = entryIds.filter((id) => {
      const e = this.graph.getEntity(id);
      return e && CASE_ENTRY_TYPES.includes(e.type);
    });
    if (!ids.length) throw new AppError('validation_error', 'Keine passenden Einträge für einen Vorgang ausgewählt.');
    return this.graph.linkMany(ids, c.id, 'belongs_to', { trigger: opts.trigger, action: 'case.assign' });
  }
}
