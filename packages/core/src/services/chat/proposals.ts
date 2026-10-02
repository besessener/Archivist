import type { StoredAgentAction } from '@archivist/shared';
import { normalizeName } from '../../util/text';
import type { ActionService } from '../actions';
import { shortAnswer, type ConvState, type Pending, type Reply } from '../chat-state';
import type { ConversationStore } from './conversation-store';
import type { ChatRequest } from './types';

export interface ProposalChoice {
  action: StoredAgentAction;
  confirm: boolean;
}

const ORDINALS = ['ersten', 'zweiten', 'dritten', 'vierten', 'funften'];

/** Approving or refusing the proposal cards of a conversation by chat message. */
export class ChatProposals {
  constructor(
    private readonly actions: ActionService,
    private readonly store: ConversationStore,
  ) {}

  /** Only a clear local „ja“ (or a click / an explicit choice) executes a card – never the classifier's reading of a message (#199). */
  async decide({ conversationId, text, intent, state }: ChatRequest): Promise<Reply> {
    const confirm = intent.intent === 'proposal_confirm';
    const replyIntent = confirm ? 'proposal_confirm' : 'proposal_reject';
    const all = this.store.openCards(conversationId);
    // a card named by the LLM only narrows a refusal; an approval of one of several cards is always asked back
    const named = intent.proposalId && !confirm ? all.filter((a) => a.id === intent.proposalId) : [];
    const cards = named.length ? named : all;
    if (confirm && cards.length === 1 && shortAnswer(text) !== 'yes')
      return {
        intent: replyIntent,
        content: `Soll ich „${cards[0]!.label}“ ausführen? Antworte mit „ja“ oder „nein“ – oder nutze die Knöpfe an der Karte.`,
        actions: cards,
        confidence: 0.5,
        state: { ...state, pending: { kind: 'proposal_choice', confirm: false, actionIds: cards.map((a) => a.id) } },
      };
    if (cards.length === 0)
      return {
        intent: replyIntent,
        content: 'Es gibt hier keinen offenen Vorschlag. Bestätigen kann ich nur Vorschläge, die in diesem Gespräch als Karte angezeigt werden.',
        confidence: 0.5,
        state,
      };
    if (cards.length > 1)
      return {
        intent: replyIntent,
        content: `Welchen Vorschlag meinst du?\n\n${cards.map((a, i) => `${i + 1}. ${a.label}`).join('\n')}\n\nAntworte mit der Nummer oder nutze die Knöpfe an der Karte.`,
        actions: cards,
        confidence: 0.5,
        state: { ...state, pending: { kind: 'proposal_choice', confirm, actionIds: cards.map((a) => a.id) } },
      };
    return this.resolve({ action: cards[0]!, confirm }, state);
  }

  /** Evaluates the answer to „Welchen Vorschlag meinst du?“: number, ordinal or part of the label. */
  answerChoice(text: string, pending: Extract<Pending, { kind: 'proposal_choice' }>): ProposalChoice | null {
    const open = this.actions.getMany(pending.actionIds);
    const action = open[chosenIndex(text, open)];
    if (!action || action.status !== 'proposed') return null;
    const answer = shortAnswer(text.replace(/^\s*(?:nummer\s+|nr\.?\s+)?\d+[.):,]?\s*/i, ''));
    return { action, confirm: answer === 'no' ? false : answer === 'yes' ? true : pending.confirm };
  }

  async resolve(choice: ProposalChoice, state: ConvState): Promise<Reply> {
    const { action, confirm } = choice;
    if (confirm && action.requiredConfirmation === 'strong')
      return {
        intent: 'proposal_confirm',
        content: `Dieser Vorschlag ist besonders kritisch („${action.label}“). Bitte bestätige ihn über die Karte im Chat bzw. in den Insights.`,
        actions: [action],
        confidence: 0.5,
        state,
      };
    const resolved = await this.actions.resolve(action.id, confirm ? 'approve' : 'reject', { confirmed: true, strongConfirmed: false });
    return {
      intent: confirm ? 'proposal_confirm' : 'proposal_reject',
      content: confirm ? approvedText(action, resolved) : `Verstanden, ich habe den Vorschlag abgelehnt: ${action.label}.`,
      confidence: 0.9,
      state,
    };
  }
}

function chosenIndex(text: string, open: StoredAgentAction[]): number {
  const normalized = normalizeName(text);
  const number = /^(?:nummer\s+|nr\s+)?(\d+)\b/.exec(normalized)?.[1];
  const index = number ? Number(number) - 1 : ORDINALS.findIndex((o) => new RegExp(`\\b${o}\\b`).test(normalized));
  if (index >= 0) return index;
  const matches = open.filter((a) => normalized.length >= 4 && normalizeName(a.label).includes(normalized));
  if (matches.length === 1) return open.indexOf(matches[0]!);
  // „Soll ich X ausführen?“ (a single card): only a clear „ja“ or „nein“ answers it
  return open.length === 1 && shortAnswer(text) ? 0 : -1;
}

function approvedText(action: StoredAgentAction, resolved: StoredAgentAction): string {
  if (resolved.status === 'executed') return `Erledigt: ${action.label}. ${resolved.result ?? ''}`;
  if (resolved.status === 'withdrawn')
    return `${resolved.result ?? 'Der Vorschlag ist nicht mehr aktuell.'} Frag mich gern erneut, dann prüfe ich die aktuelle Lage.`;
  return `Die Aktion konnte nicht ausgeführt werden: ${resolved.result ?? 'unbekannter Fehler'}`;
}
