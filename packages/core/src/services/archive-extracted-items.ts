import type { AgentActionProposal, DocumentProposal, EntityRef, StoredAgentAction } from '@archivist/shared';
import { truncate } from '../util/text';
import type { DocRow } from './documents';
import { EXTRACTED_NOTIFICATION_PREFIX, type NotificationService } from './notifications';
import { matchOpenItems, type OpenItemService } from './open-items';

/** Upper bound of decision proposals per document (protection against a runaway classification). */
const MAX_DOCUMENT_DECISIONS = 10;
const MAX_DOCUMENT_OPEN_ITEMS = 3;
const PROPOSED_DECISIONS_PATH = '/decisions/proposed/';

/** Where proposals go (the action service); typed by shape, since the action service module depends on the archive. */
export interface ProposalSink {
  propose(input: AgentActionProposal & { label: string }): StoredAgentAction;
}

type FoundOpenItem = DocumentProposal['possibleOpenItems'][number];
type FoundDecision = DocumentProposal['possibleDecisions'][number];

interface Source {
  row: DocRow;
  proposal: DocumentProposal;
  docRef: EntityRef;
  rationale: string;
}

/** Proposes decisions and open items found in an archived document; a matching active open item gets the document as a source. */
export class ExtractedItemProposer {
  private actions!: ProposalSink;
  private openItems!: OpenItemService;

  constructor(private readonly notifications: NotificationService) {}

  wire(deps: { actions: ProposalSink; openItems: OpenItemService }): void {
    this.actions = deps.actions;
    this.openItems = deps.openItems;
  }

  propose(row: DocRow, proposal: DocumentProposal | null): void {
    if (!proposal) return;
    const source: Source = {
      row,
      proposal,
      docRef: { type: 'document', id: row.id, label: row.title },
      rationale: `Im Dokument „${row.title}“ erkannt.`,
    };
    const active = proposal.possibleOpenItems.length ? this.openItems.list({ onlyActive: true }) : [];
    const openActions = proposal.possibleOpenItems.slice(0, MAX_DOCUMENT_OPEN_ITEMS).flatMap((item) => {
      const match = matchOpenItems({ hint: item.title, items: active, threshold: 0.75 });
      if (match.status !== 'match') return [this.proposeOpenItem(source, item)];
      // the document is already a source (e.g. archived again) – nothing to propose
      if (match.item.sourceIds.includes(row.id)) return [];
      return [this.proposeAddedSource(source, { item, existing: match.item })];
    });
    // every decision found (the classification yields only a few per document), each with its own participants (#178)
    const decisionActions = proposal.possibleDecisions.slice(0, MAX_DOCUMENT_DECISIONS).map((decision) => this.proposeDecision(source, decision));
    this.notify(row, { kind: 'open', actions: openActions });
    this.notify(row, { kind: 'decision', actions: decisionActions });
  }

  private proposeAddedSource(source: Source, found: { item: FoundOpenItem; existing: { id: string; title: string } }): StoredAgentAction {
    const { item, existing } = found;
    return this.actions.propose({
      actionType: 'add_open_item_source',
      label: `Punkt „${truncate(existing.title, 60)}“ um Quelle ergänzen`,
      rationale: `${source.rationale} Der Punkt ist bereits erfasst.`,
      confidence: 0.6,
      affectedEntities: [{ type: 'task', id: existing.id, label: existing.title }, source.docRef],
      requiredConfirmation: 'confirm',
      proposedParameters: {
        openItemId: existing.id,
        documentId: source.row.id,
        description: item.description ?? null,
        dueAt: item.dueAt ?? null,
        responsible: item.responsible ?? null,
      },
    });
  }

  private proposeOpenItem(source: Source, item: FoundOpenItem): StoredAgentAction {
    return this.actions.propose({
      actionType: 'create_open_item',
      label: `Offenen Punkt anlegen: ${item.title}`,
      rationale: source.rationale,
      confidence: 0.6,
      affectedEntities: [source.docRef],
      requiredConfirmation: 'confirm',
      proposedParameters: {
        title: item.title,
        description: item.description ?? null,
        dueAt: item.dueAt ?? null,
        responsible: item.responsible ?? null,
        sourceIds: [source.row.id],
        topic: source.proposal.topic,
        project: source.proposal.project,
      },
    });
  }

  private proposeDecision(source: Source, decision: FoundDecision): StoredAgentAction {
    return this.actions.propose({
      actionType: 'record_decision',
      label: `Entscheidung erfassen: ${decision.title}`,
      rationale: source.rationale,
      confidence: 0.55,
      affectedEntities: [source.docRef],
      requiredConfirmation: 'confirm',
      proposedParameters: {
        title: decision.title,
        decisionText: decision.decisionText,
        decidedAt: decision.decidedAt ?? null,
        // empty if the document does not say who decided: the decision then stays a draft and asks for them
        participants: decision.participants ?? [],
        topic: source.proposal.topic,
        project: source.proposal.project,
        sourceIds: [source.row.id],
        kind: decision.kind ?? null,
        evidence: decision.evidence ?? null,
      },
    });
  }

  private notify(row: DocRow, found: { kind: 'open' | 'decision'; actions: Array<{ id: string; label: string }> }): void {
    const { kind, actions } = found;
    if (actions.length === 0) return;
    this.notifications.create({
      title: kind === 'open' ? `Dokument enthält ${actions.length} mögliche offene Punkte` : `Dokument enthält ${actions.length} mögliche Entscheidung(en)`,
      description: `„${row.title}“ – bitte prüfen und bei Bedarf übernehmen.`,
      type: kind === 'open' ? 'file_has_open_item' : 'file_has_decision',
      priority: 'normal',
      affectedEntityIds: [row.id],
      proposedActions: [
        ...actions.map((a) => ({ label: a.label.slice(0, 60), kind: 'confirm_action' as const, target: a.id })),
        ...(kind === 'decision' ? [{ label: 'Alle vorgeschlagenen Entscheidungen', kind: 'navigate' as const, target: PROPOSED_DECISIONS_PATH }] : []),
        { label: 'Ausblenden', kind: 'ignore' as const },
      ],
      dedupeKey: `${EXTRACTED_NOTIFICATION_PREFIX}${kind}:${row.id}`,
    });
  }
}
