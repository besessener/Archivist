import type { AgentActionProposal } from '@archivist/shared';
import { riskOf, type RefState, type ToolContext } from './registry';
import type { Proposal } from './tool-executor';

const STRUCTURE_PLAN_TOOL = 'propose_structure';

export interface ProposalItem {
  tool: string;
  args: unknown;
  label: string;
  risk: string;
  reason: string;
}

/** What the model hears about a change that became a proposal. */
export const proposedText = (reason: string) =>
  `NICHT AUSGEFÜHRT – als Vorschlag vorbereitet (${reason}). Der Benutzer bestätigt ihn in der Karte unter deiner Antwort; sag ihm das und arbeite mit dem Rest weiter.`;

/** Items of the run's proposal card; a structure plan becomes one item per group, so it can be confirmed in parts (#304). */
export function proposalItems({ tool, args, label, reason }: Proposal, ctx: ToolContext): ProposalItem[] {
  if (tool.name !== STRUCTURE_PLAN_TOOL) return [{ tool: tool.name, args, label, risk: riskOf(tool, args, ctx), reason }];
  return (args as { groups: Array<{ documents: string[]; folder: string }> }).groups.map((group) => ({
    tool: 'move_documents',
    args: group,
    label: `Nach ${group.folder} verschieben (${group.documents.join(', ')})`,
    risk: 'write',
    reason,
  }));
}

export interface ProposalCardInput {
  runId: string;
  conversationId: string | null;
  items: ProposalItem[];
  refs: RefState;
}

/** ONE proposal card per run with every change it prepared (#298); moving documents to the trash needs the strong confirmation. */
export function proposalCard({
  runId,
  conversationId,
  items,
  refs,
}: ProposalCardInput): AgentActionProposal & { label: string; conversationId: string | null } {
  return {
    actionType: 'agent_batch',
    label: items.length === 1 ? items[0]!.label : `${items.length} vorbereitete Änderungen ausführen`,
    rationale: [...new Set(items.map((item) => item.reason))].join(' '),
    confidence: 0.8,
    affectedEntities: [],
    requiredConfirmation: items.some((item) => (item.args as { action?: string } | null)?.action === 'delete') ? 'strong' : 'confirm',
    proposedParameters: { runId, conversationId, items, refs: structuredClone(refs) },
    conversationId,
  };
}
