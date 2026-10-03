import type { ChatAnalysis } from '@archivist/shared';
import { truncate } from '../../util/text';
import type { CaptureService } from '../capture';
import { mergeReplies, words, type ConvState, type Pending, type QueuedIntent, type Reply } from '../chat-state';
import type { ChatDispatcher } from './dispatch';
import type { Classification, IntentClassifier } from './intent-classifier';
import {
  chosenSubject,
  intentKey,
  isChoice,
  parseSaveChoice,
  SAVE_ANSWER_INTENTS,
  SAVE_QUICK_REPLIES,
  saveChoiceIntent,
  withOpenItemTarget,
  type ChoicePending,
  type SaveChoice,
} from './intents';
import type { ChatTurn } from './types';
import type { WorkRunner } from './work-runner';

type SavePending = Extract<Pending, { kind: 'confirm_save' }>;

/** A short answer without a request of its own (even „ja“) is, without LLM, an attempt to answer the follow-up question. */
const SHORT_TRY_INTENTS = ['note_capture', 'proposal_confirm', 'proposal_reject'];

/** The rule-based evaluation of one message: answers to follow-up questions first, then the recognized requests. */
export class ChatFlow {
  constructor(private readonly helpers: { classifier: IntentClassifier; runner: WorkRunner; dispatcher: ChatDispatcher; capture: CaptureService }) {}

  async handle(turn: ChatTurn): Promise<Reply> {
    let state = turn.state;
    if (isChoice(state.pending)) {
      const pending = state.pending;
      state = { ...state, pending: null };
      const answered = await this.answerChoice(pending, { ...turn, state });
      if (answered) return answered;
    }
    // „Entscheidung, Ereignis, Notiz oder nichts?“: deterministically first, otherwise with a hint via the LLM
    const saving = state.pending?.kind === 'confirm_save' ? state.pending : null;
    const choice = saving ? parseSaveChoice(turn.text) : null;
    if (saving && choice) return this.applySaveChoice({ ...turn, state }, { choice, pending: saving });
    const classified = await this.helpers.classifier.classify({ ...turn, state });
    const reply = await this.replyTo({ ...turn, state }, { classified, saving });
    if (classified.viaLlm || !classified.llmError) return reply;
    return {
      ...reply,
      content: `${reply.content}\n\n_Hinweis: ${classified.llmError} Ich habe die Nachricht regelbasiert ausgewertet – Ergebnisse können ungenauer sein._`,
      ...(classified.llmFailed ? { errorMessage: classified.llmError } : {}),
      uncertainties: [...(reply.uncertainties ?? []), 'Ohne LLM nur regelbasierte Auswertung.'],
    };
  }

  /** The answer to a choice („Welchen Vorschlag meinst du?“, „Meinst du ‚A‘ oder ‚B‘?“ …); null when the message is no answer. */
  private async answerChoice(pending: ChoicePending, turn: ChatTurn): Promise<Reply | null> {
    const { conversationId, text, state } = turn;
    switch (pending.kind) {
      case 'proposal_choice': {
        const chosen = this.helpers.dispatcher.proposals.answerChoice(text, pending);
        return chosen ? this.helpers.dispatcher.proposals.resolve(chosen, state) : null;
      }
      case 'open_item_choice': {
        const chosen = this.helpers.capture.answerOpenItemChoice(text, pending);
        return chosen ? this.resume(turn, { text: pending.text, intent: withOpenItemTarget(pending.intent, chosen.id) }) : null;
      }
      case 'subject_choice': {
        const chosen = chosenSubject(text, pending);
        return chosen ? this.resume(turn, { text: pending.text, intent: { ...pending.intent, topic: chosen, project: null, query: null } }) : null;
      }
      case 'open_item_duplicate':
        return this.helpers.capture.answerOpenItemDuplicate({ conv: conversationId, text, state }, pending);
      case 'supersede_choice':
        return this.helpers.capture.answerSupersedeChoice({ conv: conversationId, text, state }, pending);
    }
  }

  /** The original request continues with the chosen item, followed by the deferred ones. */
  private resume(turn: ChatTurn, item: QueuedIntent): Promise<Reply> {
    return this.helpers.runner.run({
      conversationId: turn.conversationId,
      fresh: [item],
      queued: turn.state.queue ?? [],
      state: { ...turn.state, queue: [] },
      viaLlm: true,
      clarification: null,
    });
  }

  private async replyTo(turn: ChatTurn, evaluation: { classified: Classification; saving: SavePending | null }): Promise<Reply> {
    const { analysis, viaLlm } = evaluation.classified;
    const { saving } = evaluation;
    const shortTry = !viaLlm && words(turn.text) <= 8 && SHORT_TRY_INTENTS.includes(analysis.intents[0]?.intent ?? '');
    if (saving && shortTry) return askSaveAgain(saving, turn.state);
    if (saving && analysis.saveAs) return this.saveThenContinue(turn, { analysis, viaLlm, pending: saving, choice: analysis.saveAs });
    return this.runIntents(turn, { analysis, viaLlm });
  }

  /** The save choice answers the question; further requests of the message run afterwards. */
  private async saveThenContinue(
    turn: ChatTurn,
    answer: { analysis: ChatAnalysis; viaLlm: boolean; pending: SavePending; choice: SaveChoice },
  ): Promise<Reply> {
    const first = await this.applySaveChoice(turn, answer);
    const others = answer.analysis.intents.filter((i) => !SAVE_ANSWER_INTENTS.has(i.intent)).map((intent) => ({ text: turn.text, intent }));
    const after = first.state ?? {};
    if (!others.length) return first;
    if (after.pending) return { ...first, state: { ...after, queue: [...(after.queue ?? []), ...others] } };
    const more = await this.helpers.runner.run({
      conversationId: turn.conversationId,
      fresh: others,
      queued: [],
      state: { ...after, pending: null, queue: [] },
      viaLlm: answer.viaLlm,
      clarification: null,
    });
    return mergeReplies([first, more], more.state ?? after);
  }

  /** All recognized requests of the message (each once), then the ones deferred from the last message. */
  private runIntents(turn: ChatTurn, classified: { analysis: ChatAnalysis; viaLlm: boolean }): Promise<Reply> {
    const { analysis } = classified;
    // the same request twice counts once – but one update per open item („für alle drei“) are different requests
    const seen = new Set<string>();
    const fresh = analysis.intents
      .filter((intent) => {
        const key = intentKey(intent);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .filter((intent) => !(analysis.clarification && (intent.intent === 'unknown' || intent.intent === 'smalltalk')))
      .map((intent) => ({ text: turn.text, intent }));
    return this.helpers.runner.run({
      conversationId: turn.conversationId,
      fresh,
      queued: turn.state.queue ?? [],
      state: turn.state,
      viaLlm: classified.viaLlm,
      clarification: analysis.clarification ?? null,
    });
  }

  /** Saves the uncertain decision the chosen way, then resumes the deferred requests. */
  private async applySaveChoice(turn: ChatTurn, answer: { choice: SaveChoice; pending: SavePending }): Promise<Reply> {
    const { choice, pending } = answer;
    const rest = turn.state.queue ?? [];
    const base: ConvState = { ...turn.state, pending: null, queue: [] };
    const first: Reply =
      choice === 'nothing'
        ? { intent: 'clarification', content: 'Okay, ich speichere dazu nichts.', confidence: 1, state: base }
        : await this.helpers.dispatcher.dispatch(
            { conversationId: turn.conversationId, text: pending.text, intent: saveChoiceIntent(choice, pending), state: base },
            { viaLlm: true },
          );
    // the remaining intents of the original message continue with their original text
    if (first.state?.pending || !rest.length) return { ...first, state: { ...(first.state ?? base), queue: first.state?.pending ? rest : [] } };
    const more = await this.helpers.runner.run({
      conversationId: turn.conversationId,
      fresh: [],
      queued: rest,
      state: { ...(first.state ?? base), pending: null, queue: [] },
      viaLlm: true,
      clarification: null,
    });
    return mergeReplies([first, more], more.state ?? base);
  }
}

/** Asks „Entscheidung, Ereignis, Notiz oder nichts?“ again – with buttons; the deferred requests remain. */
function askSaveAgain(pending: SavePending, state: ConvState): Reply {
  return {
    intent: 'clarification',
    content: `Das habe ich nicht verstanden. Wie soll ich „${truncate(pending.intent.segment ?? pending.text, 140)}“ speichern – als **Entscheidung**, als **Ereignis**, als **Notiz** oder gar nicht?`,
    quickReplies: SAVE_QUICK_REPLIES,
    confidence: 0.4,
    state,
  };
}
