import { ActionParamSchemas, type AgentActionProposal, type AgentActionType, type EntityRef, type StoredAgentAction } from '@archivist/shared';
import { desc, eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import { agentActions } from '../db/schema';
import { AppError, toErrorInfo } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import type { ArchiveService } from './archive';
import type { AuditService } from './audit';
import type { ContradictionService } from './contradictions';
import type { DecisionService } from './decisions';
import type { DocumentService } from './documents';
import type { KnowledgeGraphService } from './knowledge-graph';
import type { OpenItemService } from './open-items';
import type { ReminderService } from './reminders';
import type { ScannerService } from './scanner';

type Row = typeof agentActions.$inferSelect;

const map = (r: Row): StoredAgentAction => ({
  id: r.id,
  conversationId: r.conversationId,
  actionType: r.actionType as AgentActionType,
  label: r.label,
  rationale: r.rationale,
  confidence: r.confidence,
  affectedEntities: r.affectedEntities as EntityRef[],
  requiredConfirmation: r.requiredConfirmation as StoredAgentAction['requiredConfirmation'],
  proposedParameters: r.params as Record<string, unknown>,
  status: r.status as StoredAgentAction['status'],
  result: r.result,
  createdAt: r.createdAt,
  resolvedAt: r.resolvedAt,
});

export interface ActionDeps {
  archive: ArchiveService;
  documents: DocumentService;
  decisions: DecisionService;
  openItems: OpenItemService;
  contradictions: ContradictionService;
  graph: KnowledgeGraphService;
  scanner: ScannerService;
  reminders: ReminderService;
  audit: AuditService;
}

/**
 * Agentenaktionen: Der Agent erzeugt nur Vorschläge (`propose`). Ausführung erfolgt ausschließlich über `resolve`
 * nach Entscheidung des Benutzers. Parameter werden pro Aktionstyp mit Zod validiert.
 */
export class ActionService {
  private deps!: ActionDeps;

  constructor(private readonly ctx: AppContext) {}

  wire(deps: ActionDeps): void {
    this.deps = deps;
  }

  private get db() {
    return this.ctx.database.db;
  }

  propose(input: AgentActionProposal & { label: string; conversationId?: string | null }): StoredAgentAction {
    const schema = ActionParamSchemas[input.actionType];
    const parsed = schema.safeParse(input.proposedParameters);
    if (!parsed.success) {
      throw new AppError('validation_error', 'Die vorgeschlagene Aktion hat ungültige Parameter und wurde verworfen.', {
        details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }
    const row: Row = {
      id: newId(),
      conversationId: input.conversationId ?? null,
      actionType: input.actionType,
      label: input.label,
      rationale: input.rationale,
      confidence: input.confidence,
      affectedEntities: input.affectedEntities,
      requiredConfirmation: input.requiredConfirmation,
      params: parsed.data,
      status: 'proposed',
      result: null,
      createdAt: nowIso(),
      resolvedAt: null,
    };
    this.db.insert(agentActions).values(row).run();
    this.ctx.events.changed('status');
    return map(row);
  }

  get(id: string): StoredAgentAction {
    const r = this.db.select().from(agentActions).where(eq(agentActions.id, id)).get();
    if (!r) throw new AppError('validation_error', 'Aktion nicht gefunden.');
    return map(r);
  }

  getMany(ids: string[]): StoredAgentAction[] {
    return ids.flatMap((id) => {
      const r = this.db.select().from(agentActions).where(eq(agentActions.id, id)).get();
      return r ? [map(r)] : [];
    });
  }

  list(status?: StoredAgentAction['status']): StoredAgentAction[] {
    return this.db
      .select()
      .from(agentActions)
      .where(status ? eq(agentActions.status, status) : undefined)
      .orderBy(desc(agentActions.createdAt))
      .limit(200)
      .all()
      .map(map);
  }

  /**
   * Offene Vorschläge, die in dieser Unterhaltung als Karte angezeigt wurden und dort entstanden sind (neueste zuerst).
   * Vorschläge anderer Quellen (Archivprüfung, Insights, andere Unterhaltungen) sind hier nie enthalten.
   */
  openInConversation(conversationId: string, shownActionIds: string[]): StoredAgentAction[] {
    const shown = new Set(shownActionIds);
    return this.list('proposed').filter((a) => a.conversationId === conversationId && shown.has(a.id));
  }

  async resolve(
    id: string,
    decision: 'approve' | 'reject',
    opts: { confirmed?: boolean; strongConfirmed?: boolean; overrides?: Record<string, unknown> },
  ): Promise<StoredAgentAction> {
    const action = this.get(id);
    if (action.status !== 'proposed') return action;
    const now = nowIso();
    if (decision === 'reject') {
      this.db.update(agentActions).set({ status: 'rejected', resolvedAt: now }).where(eq(agentActions.id, id)).run();
      // eine Beziehungskarte hat Bestätigen und Ablehnen: Ablehnen verwirft die vorgeschlagene Beziehung
      if (action.actionType === 'confirm_relation') {
        const params = ActionParamSchemas.confirm_relation.parse(action.proposedParameters);
        this.deps.graph.setRelationStatus(params.relationId, 'rejected');
        this.deps.audit.log({ action: 'relation.reject', actor: 'user', trigger: 'confirmation', confirmed: true, entityIds: [params.relationId] });
      }
      this.deps.audit.log({
        action: `action.reject:${action.actionType}`,
        actor: 'user',
        trigger: 'confirmation',
        confirmed: true,
        entityIds: action.affectedEntities.map((e) => e.id),
      });
      this.ctx.events.changed('status', 'insights');
      return this.get(id);
    }
    if (!opts.confirmed) throw new AppError('permission_error', 'Diese Aktion erfordert eine ausdrückliche Bestätigung.');
    if (action.requiredConfirmation === 'strong' && !opts.strongConfirmed) {
      throw new AppError('permission_error', 'Diese Aktion ist besonders kritisch und erfordert eine zweite, ausdrückliche Bestätigung.');
    }
    this.db.update(agentActions).set({ status: 'approved' }).where(eq(agentActions.id, id)).run();
    try {
      const params = ActionParamSchemas[action.actionType].parse({ ...action.proposedParameters, ...(opts.overrides ?? {}) });
      const result = await this.execute(action.actionType, params as never);
      this.db.update(agentActions).set({ status: 'executed', result, resolvedAt: nowIso() }).where(eq(agentActions.id, id)).run();
    } catch (err) {
      const info = toErrorInfo(err);
      this.ctx.logger.error('actions', `Aktion fehlgeschlagen: ${action.actionType}`, { error: err });
      this.db
        .update(agentActions)
        .set({ status: 'failed', result: info.message + (info.details ? ` (${info.details})` : ''), resolvedAt: nowIso() })
        .where(eq(agentActions.id, id))
        .run();
    }
    this.ctx.events.changed('status', 'insights', 'notifications');
    return this.get(id);
  }

  private async execute(type: AgentActionType, p: Record<string, never> & Record<string, unknown>): Promise<string> {
    const d = this.deps;
    const trigger = 'agent_action';
    switch (type) {
      case 'archive_documents': {
        const params = ActionParamSchemas.archive_documents.parse(p);
        const res = await d.archive.execute(params.items, {
          confirmed: true,
          approveNewCategories: params.approveNewCategories,
          confirmMove: params.items.some((i) => i.mode === 'move'),
          trigger,
        });
        return `${res.success} archiviert, ${res.skipped} übersprungen, ${res.failed} fehlgeschlagen, ${res.conflicts} Konflikte.`;
      }
      case 'relocate_documents': {
        const params = ActionParamSchemas.relocate_documents.parse(p);
        const res = await d.archive.relocate(params.items, { confirmed: true, trigger });
        return `${res.success} verschoben, ${res.skipped} übersprungen, ${res.failed} fehlgeschlagen, ${res.conflicts} Konflikte.`;
      }
      case 'assign_documents': {
        const params = ActionParamSchemas.assign_documents.parse(p);
        for (const id of params.documentIds) d.documents.assign(id, { topic: params.topic ?? undefined, project: params.project ?? undefined }, { trigger });
        return `${params.documentIds.length} Dokument(e) zugeordnet.`;
      }
      case 'supersede_decision': {
        const params = ActionParamSchemas.supersede_decision.parse(p);
        d.decisions.supersede(params.oldDecisionId, params.newDecisionId, { confirmed: true, trigger });
        return 'Ältere Entscheidung als überholt markiert.';
      }
      case 'revoke_decision': {
        const params = ActionParamSchemas.revoke_decision.parse(p);
        d.decisions.revoke(params.decisionId, { confirmed: true, trigger });
        return 'Entscheidung widerrufen.';
      }
      case 'resolve_contradiction': {
        const params = ActionParamSchemas.resolve_contradiction.parse(p);
        d.contradictions.resolve(params.contradictionId, params.resolution, {
          confirmed: true,
          supersedeOldDecisionId: params.supersedeOldDecisionId,
          supersedeNewDecisionId: params.supersedeNewDecisionId,
        });
        return 'Widerspruch aufgelöst.';
      }
      case 'close_open_item': {
        const params = ActionParamSchemas.close_open_item.parse(p);
        d.openItems.close(params.openItemId, params.status, { confirmed: true, trigger });
        return 'Offener Punkt geschlossen.';
      }
      case 'merge_topics': {
        const params = ActionParamSchemas.merge_topics.parse(p);
        const r = d.graph.mergeEntities(params.sourceTopicId, params.targetTopicId);
        d.audit.log({ action: 'topics.merge', actor: 'user', trigger, confirmed: true, entityIds: [params.sourceTopicId, params.targetTopicId], after: r });
        return `Themen zusammengeführt (${r.relationsMoved} Beziehungen übernommen).`;
      }
      case 'confirm_relation': {
        const params = ActionParamSchemas.confirm_relation.parse(p);
        d.graph.setRelationStatus(params.relationId, 'confirmed');
        d.audit.log({ action: 'relation.confirm', actor: 'user', trigger, confirmed: true, entityIds: [params.relationId] });
        return 'Beziehung bestätigt.';
      }
      case 'reject_relation': {
        const params = ActionParamSchemas.reject_relation.parse(p);
        d.graph.setRelationStatus(params.relationId, 'rejected');
        d.audit.log({ action: 'relation.reject', actor: 'user', trigger, confirmed: true, entityIds: [params.relationId] });
        return 'Beziehung abgelehnt.';
      }
      case 'exclude_path': {
        const params = ActionParamSchemas.exclude_path.parse(p);
        d.scanner.exclude(params.kind, params.path);
        return 'Von künftigen Scans ausgeschlossen.';
      }
      case 'create_category': {
        const params = ActionParamSchemas.create_category.parse(p);
        d.archive.createCategory(params.path, true);
        return 'Kategorie angelegt.';
      }
      case 'set_reminder': {
        const params = ActionParamSchemas.set_reminder.parse(p);
        d.reminders.create({ targetType: params.targetType as 'custom', targetId: params.targetId, title: params.title, remindAt: params.remindAt });
        return 'Erinnerung angelegt.';
      }
      case 'create_open_item': {
        const params = ActionParamSchemas.create_open_item.parse(p);
        d.openItems.create(
          {
            title: params.title,
            description: params.description,
            dueAt: params.dueAt,
            sourceIds: params.sourceIds,
            topic: params.topic,
            project: params.project,
            priority: 'normal',
            confidence: 0.7,
          },
          { actor: 'agent', trigger },
        );
        return 'Offener Punkt angelegt.';
      }
      case 'record_decision': {
        const params = ActionParamSchemas.record_decision.parse(p);
        d.decisions.create(
          {
            decisionText: params.decisionText,
            title: params.title,
            decidedAt: params.decidedAt,
            participants: params.participants,
            topic: params.topic,
            project: params.project,
            sourceIds: params.sourceIds,
            alternatives: [],
            unknownFields: [],
            asDraft: false,
            confidence: 0.7,
          },
          { actor: 'agent', trigger },
        );
        return 'Entscheidung erfasst (ggf. als Entwurf mit offenen Pflichtfeldern).';
      }
    }
  }
}
