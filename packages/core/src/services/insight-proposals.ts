import type { AgentActionProposal, AgentActionType, InsightChoice, StoredAgentAction } from '@archivist/shared';
import type { insights } from '../db/schema';

type Row = typeof insights.$inferSelect;

/** Recommended action of an insight: proposed only while the insight is open, replaced when its parameters change. */
export interface InsightActionSpec {
  proposal: AgentActionProposal & { label: string };
  /** label of the recommendation shown on the insight */
  label: string;
}

/** One answer of a question insight; without `proposal`, choosing it changes nothing and rejects the insight („verschieden“). */
export interface InsightChoiceSpec {
  /** stable within the insight; identifies the answer across runs (e.g. `project`, `topic`, `different`, an entity id) */
  id: string;
  label: string;
  /** what happens when this answer is chosen (shown before confirming) */
  description?: string | null;
  proposal?: (AgentActionProposal & { label: string }) | null;
}

/** The parts of an insight that carry proposals. */
export interface ProposalInput {
  recommendedActionId?: string | null;
  recommendedActionLabel?: string | null;
  /** alternative to `recommendedActionId`: the action is only proposed if the insight is (re)opened, never orphaned */
  action?: InsightActionSpec;
  /** Turns the insight into a question answered via `InsightService.choose`; the answers' actions live only while it is open. */
  choices?: InsightChoiceSpec[];
}

/** The action functions used here, kept structural: importing ActionService would close an import cycle back to insights.ts. */
interface ProposalActions {
  getMany(ids: string[]): StoredAgentAction[];
  propose(proposal: AgentActionProposal & { label: string }): StoredAgentAction;
  withdraw(id: string, reason: string): unknown;
  normalizeParams(actionType: AgentActionType, params: Record<string, unknown>): Record<string, unknown>;
}

/** The insight being (re)opened and its stored row, if it exists already. */
interface InsightUpdate {
  input: ProposalInput;
  existing: Row | undefined;
}

/** The proposals behind an insight: its recommended action and the actions of its answers, kept while unchanged. */
export class InsightProposals {
  constructor(private readonly actions: ProposalActions) {}

  /** Recommended action of an (re)opened insight: keeps the current proposal if it is still undecided and unchanged. */
  recommendation({ input, existing }: InsightUpdate): { actionId: string | null; actionLabel: string | null; replaced?: string } {
    if (!input.action) {
      const actionId = input.recommendedActionId ?? existing?.recommendedActionId ?? null;
      return {
        actionId,
        actionLabel: input.recommendedActionLabel ?? existing?.recommendedActionLabel ?? null,
        replaced: existing?.recommendedActionId && existing.recommendedActionId !== actionId ? existing.recommendedActionId : undefined,
      };
    }
    const { proposal, label } = input.action;
    const current = existing?.recommendedActionId ? this.actions.getMany([existing.recommendedActionId])[0] : undefined;
    if (current && this.isUnchanged(current, proposal)) return { actionId: current.id, actionLabel: label };
    const action = this.actions.propose(proposal);
    return { actionId: action.id, actionLabel: label, replaced: current?.status === 'proposed' ? current.id : undefined };
  }

  /** Answers of an (re)opened question: undecided, unchanged proposals stay; those of replaced or dropped answers are returned for withdrawal. */
  answers({ input, existing }: InsightUpdate): { choices: InsightChoice[]; replaced: string[] } {
    const before = existing ? (existing.choices as InsightChoice[]) : [];
    if (!input.choices) return { choices: before, replaced: [] };
    const current = new Map(this.actions.getMany(before.flatMap((c) => (c.actionId ? [c.actionId] : []))).map((a) => [a.id, a]));
    const kept = new Set<string>();
    const choices = input.choices.map((spec): InsightChoice => {
      const base = { id: spec.id, label: spec.label, description: spec.description ?? null };
      if (!spec.proposal) return { ...base, actionId: null };
      const previous = before.find((c) => c.id === spec.id)?.actionId;
      const action = previous ? current.get(previous) : undefined;
      if (action && this.isUnchanged(action, spec.proposal)) {
        kept.add(action.id);
        return { ...base, actionId: action.id };
      }
      return { ...base, actionId: this.actions.propose(spec.proposal).id };
    });
    const replaced = [...current.values()].filter((a) => a.status === 'proposed' && !kept.has(a.id)).map((a) => a.id);
    return { choices, replaced };
  }

  /** Withdraws the undecided proposals of an insight (recommendation and answers), except `keep`. */
  withdrawAll(row: { recommendedActionId: string | null; choices: unknown }, withdrawal: { reason: string; keep?: string | null }): void {
    const ids = [row.recommendedActionId, ...(row.choices as InsightChoice[]).map((c) => c.actionId)];
    for (const id of new Set(ids)) if (id && id !== withdrawal.keep) this.actions.withdraw(id, withdrawal.reason);
  }

  private isUnchanged(current: StoredAgentAction, proposal: AgentActionProposal): boolean {
    const wanted = JSON.stringify(this.actions.normalizeParams(proposal.actionType, proposal.proposedParameters));
    return current.status === 'proposed' && current.actionType === proposal.actionType && JSON.stringify(current.proposedParameters) === wanted;
  }
}
