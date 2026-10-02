import type { Decision, StoredAgentAction } from '@archivist/shared';
import { AppError } from '../../util/errors';
import { nameSimilarity, normalizeName } from '../../util/text';
import { decisionRef, shortAnswer, words, type ConvState, type Pending, type Reply } from '../chat-state';
import type { CaptureDeps } from './capture-deps';

const ACTIVE_DECISION_STATUSES = ['active', 'confirmed'];
const NUMBER_ANSWER = /^(?:nummer\s+|nr\s+)?(\d+)$/;

const decidedOn = (decision: Decision) => decision.decidedAt?.slice(0, 10) ?? 'ohne Datum';

/** What a new decision's „ersetzt eine ältere“ leads to: a proposal card, a choice question or a note. */
export interface SupersedeFollowUp {
  actions: StoredAgentAction[];
  lines: string[];
  next: Pending | null;
}

/** Superseding decisions: finding the older decision a new one replaces and proposing to mark it as superseded. */
export class DecisionSupersede {
  constructor(private readonly deps: CaptureDeps) {}

  private activeDecisions(exceptId: string): Decision[] {
    return this.deps.decisions.list().filter((other) => other.id !== exceptId && ACTIVE_DECISION_STATUSES.includes(other.status));
  }

  /** Older decisions `decision` might supersede according to the hint (topic, title) or the same topic/project. */
  private candidates(decision: Decision, hint: string): Decision[] {
    const active = this.activeDecisions(decision.id);
    const normalizedHint = normalizeName(hint);
    if (normalizedHint)
      return active.filter(
        (other) =>
          [other.topicName, other.projectName, other.title].some((name) => name && normalizeName(name).includes(normalizedHint)) ||
          nameSimilarity(other.title, hint) >= 0.6,
      );
    if (!decision.topicId && !decision.projectId) return [];
    return active.filter((other) => (decision.topicId && other.topicId === decision.topicId) || (decision.projectId && other.projectId === decision.projectId));
  }

  private propose(conv: string, decisions: { older: Decision; newer: Decision }): StoredAgentAction {
    const { older, newer } = decisions;
    return this.deps.actions().propose({
      actionType: 'supersede_decision',
      label: `„${older.title}“ als überholt markieren`,
      rationale: 'Du hast angegeben, dass diese Entscheidung eine ältere ersetzt.',
      confidence: 0.7,
      affectedEntities: [decisionRef(older), decisionRef(newer)],
      requiredConfirmation: 'confirm',
      proposedParameters: { oldDecisionId: older.id, newDecisionId: newer.id },
      conversationId: conv,
    });
  }

  /** The agent's answer to „Welche Entscheidung wird ersetzt?“: the same proposal card as the chat's (confirmation required). */
  proposeSupersedeOf(conv: string, ids: { olderId: string; newerId: string }): StoredAgentAction {
    const older = this.deps.decisions.get(ids.olderId);
    if (!ACTIVE_DECISION_STATUSES.includes(older.status))
      throw new AppError('validation_error', `„${older.title}“ ist nicht mehr aktiv und kann nicht ersetzt werden.`);
    return this.propose(conv, { older, newer: this.deps.decisions.get(ids.newerId) });
  }

  /** After a complete decision that replaces an older one: propose the unique candidate, else ask which one is meant. */
  followUp(request: { conv: string; decision: Decision; hint: string; supersedesId: string | null; proposed: StoredAgentAction[] }): SupersedeFollowUp {
    const { conv, decision, hint, supersedesId } = request;
    const named = supersedesId ? this.activeDecisions(decision.id).filter((other) => other.id === supersedesId) : [];
    const candidates = named.length ? named : this.candidates(decision, hint);
    if (candidates.length === 1) {
      const older = candidates[0]!;
      const alreadyProposed = request.proposed.some((action) => (action.proposedParameters as { oldDecisionId?: string }).oldDecisionId === older.id);
      if (alreadyProposed) return { actions: [], lines: [], next: null };
      return {
        actions: [this.propose(conv, { older, newer: decision })],
        lines: [`Soll die ältere Entscheidung „${older.title}“ (${decidedOn(older)}) als überholt markiert werden?`],
        next: null,
      };
    }
    // without a unique match we ask – never just take the first active decision that comes along
    const list = (candidates.length ? candidates : this.activeDecisions(decision.id)).slice(0, 5);
    if (list.length === 0) return { actions: [], lines: ['Eine ältere aktive Entscheidung, die dadurch ersetzt würde, habe ich nicht gefunden.'], next: null };
    const choices = list.map((other, index) => `${index + 1}. ${other.title} (${decidedOn(other)})`).join('\n');
    return {
      actions: [],
      lines: [`Welche Entscheidung wird ersetzt?\n${choices}\n\nAntworte mit der Nummer oder dem Titel – oder „keine“.`],
      next: { kind: 'supersede_choice', newDecisionId: decision.id, candidateIds: list.map((other) => other.id) },
    };
  }

  /** Answer to „Welche Entscheidung wird ersetzt?“: number, „keine“, or title or topic. Otherwise null. */
  answerChoice(request: { conv: string; text: string; state: ConvState }, pending: Extract<Pending, { kind: 'supersede_choice' }>): Reply | null {
    const { conv, text, state } = request;
    const normalized = normalizeName(text);
    const newer = this.deps.decisions.get(pending.newDecisionId);
    if (/^(keine|keiner|nichts|gar keine)\b/.test(normalized) || shortAnswer(text) === 'no')
      return { intent: 'decision_supersede', content: 'Okay, ich markiere keine Entscheidung als überholt.', confidence: 0.9, state };
    const older = this.chosenDecision({ text, normalized, newer }, pending.candidateIds);
    if (!older || !ACTIVE_DECISION_STATUSES.includes(older.status)) return null;
    const action = this.propose(conv, { older, newer });
    return {
      intent: 'decision_supersede',
      content: `Soll die ältere Entscheidung „${older.title}“ (${decidedOn(older)}) als überholt markiert werden? Bitte bestätige.`,
      actions: [action],
      context: { decisions: [decisionRef(older), decisionRef(newer)] },
      confidence: 0.8,
      state,
    };
  }

  /** The listed decision a choice answer names: by number, else a unique title/topic match for a short answer. */
  private chosenDecision(answer: { text: string; normalized: string; newer: Decision }, candidateIds: string[]): Decision | undefined {
    const number = NUMBER_ANSWER.exec(answer.normalized)?.[1];
    const listed = candidateIds.flatMap((id) => {
      try {
        return [this.deps.decisions.get(id)];
      } catch {
        return [];
      }
    });
    const byNumber = number ? listed[Number(number) - 1] : undefined;
    if (byNumber || !answer.normalized || words(answer.text) > 10) return byNumber;
    const matches = this.candidates(answer.newer, answer.text);
    return matches.length === 1 ? matches[0] : undefined;
  }
}
