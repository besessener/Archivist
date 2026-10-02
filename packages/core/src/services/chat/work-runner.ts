import type { AppContext } from '../../context';
import type { AppErrorInfo } from '@archivist/shared';
import { toErrorInfo } from '../../util/errors';
import { truncate } from '../../util/text';
import { mergeReplies, openItemAsks, openItemPending, type ConvState, type Pending, type QueuedIntent, type Reply } from '../chat-state';
import { throwIfCancelled } from './cancellation';
import type { ChatDispatcher } from './dispatch';
import { describeIntent, needsDecisionConfirmation, SAVE_QUICK_REPLIES } from './intents';
import type { PendingQuestions } from './pending-questions';

/** Requests of the current message that are already done, per conversation – for the last-resort error handling. */
export type ProgressLog = Map<string, { replies: Reply[]; state: ConvState }>;

/** The requests of one message (`fresh`) and the ones deferred from the last message (`queued`). */
export interface WorkInput {
  conversationId: string;
  fresh: QueuedIntent[];
  queued: QueuedIntent[];
  state: ConvState;
  viaLlm: boolean;
  clarification: string | null;
}

/** State of one run through the requests of a message. */
interface WorkRun {
  input: WorkInput;
  work: QueuedIntent[];
  old: Pending | null;
  consumed: boolean;
  replies: Reply[];
  current: ConvState;
  deferred: QueuedIntent[];
  /** optional follow-up questions (owner/due date, „Thema oder Projekt?“) do not hold up further requests */
  optional: Pending | null;
  clarification: string | null;
}

export function errorDetails(info: AppErrorInfo): string {
  return info.message + (info.details ? ` (${info.details})` : '');
}

/** Runs the requests of a message in order; a new follow-up question defers the rest, unclear decisions are never saved unasked. */
export class WorkRunner {
  constructor(
    private readonly ctx: AppContext,
    private readonly helpers: { dispatcher: ChatDispatcher; pending: PendingQuestions; progress: ProgressLog },
  ) {}

  async run(input: WorkInput): Promise<Reply> {
    const run: WorkRun = {
      input,
      work: [...input.fresh, ...input.queued],
      old: input.state.pending ?? null,
      consumed: false,
      replies: [],
      current: { ...input.state, pending: null, queue: [] },
      deferred: [],
      optional: null,
      clarification: input.clarification,
    };
    for (let i = 0; i < run.work.length; i += 1) {
      throwIfCancelled();
      const item = run.work[i]!;
      if (needsDecisionConfirmation(item.intent)) this.askToConfirmDecision(run, item);
      else await this.runItem(run, { item, fresh: i < input.fresh.length });
      if (run.current.pending) {
        run.deferred = run.work.slice(i + 1);
        break;
      }
    }
    return this.finish(run);
  }

  private askToConfirmDecision(run: WorkRun, item: QueuedIntent): void {
    const question =
      run.clarification?.trim() ||
      `Ich bin nicht sicher, ob das eine getroffene **Entscheidung** ist${item.intent.segment ? ` („${truncate(item.intent.segment, 140)}“)` : ''}. Soll ich sie als Entscheidung erfassen, als Ereignis in die Timeline eintragen, nur als Notiz festhalten oder nichts speichern?`;
    run.clarification = null;
    run.current = { ...run.current, pending: { kind: 'confirm_save', text: item.text, intent: item.intent } };
    run.replies.push({
      intent: 'clarification',
      content: `${question}\n\nAntworte mit „Entscheidung“, „Ereignis“, „Notiz“ oder „nichts speichern“.`,
      quickReplies: SAVE_QUICK_REPLIES,
      confidence: item.intent.confidence,
      state: run.current,
    });
  }

  /** Runs one request; a new follow-up question it asks ends up in `run.current.pending`. */
  private async runItem(run: WorkRun, next: { item: QueuedIntent; fresh: boolean }): Promise<void> {
    const { item } = next;
    // only the first matching intent of the new message answers the old follow-up question
    const answers = run.old !== null && !run.consumed && next.fresh && this.helpers.pending.answers(item.intent, run.old);
    if (answers) run.consumed = true;
    // an error swallows neither the requests done nor the following ones; the state stays as before this request
    let reply: Reply;
    try {
      const state = { ...run.current, pending: answers ? run.old : null };
      reply = await this.helpers.dispatcher.dispatch({ conversationId: run.input.conversationId, ...item, state }, { viaLlm: run.input.viaLlm });
    } catch (err) {
      throwIfCancelled();
      this.ctx.logger.error('chat', 'Request failed', { error: err, intent: item.intent.intent });
      // so the old follow-up question is not answered
      if (answers) run.consumed = false;
      const info = toErrorInfo(err);
      run.replies.push({
        intent: 'error',
        content: `Das hat nicht geklappt: ${describeIntent(item.intent)} – ${info.message}`,
        errorMessage: errorDetails(info),
        confidence: 0,
        state: run.current,
      });
      return;
    }
    run.replies.push(reply);
    run.current = { ...(reply.state ?? run.current), queue: [] };
    // an old follow-up question returned unchanged is settled, not a new one
    if (run.current.pending === run.old) run.current = { ...run.current, pending: null };
    holdOptional(run);
    this.recordProgress(run, reply);
  }

  private recordProgress(run: WorkRun, reply: Reply): void {
    const done = this.helpers.progress.get(run.input.conversationId);
    if (!done) return;
    done.replies.push(reply);
    done.state = run.current.pending || !run.optional ? run.current : { ...run.current, pending: run.optional };
  }

  private finish(run: WorkRun): Reply {
    // a still unanswered question „Thema oder Projekt?“ remains, even if the message had a different request
    const keep = run.old?.kind === 'decision' && run.old.optional && !run.consumed ? run.old : null;
    if (!run.current.pending && (run.optional || keep))
      run.current = { ...run.current, pending: run.optional?.kind === 'decision' ? run.optional : (keep ?? run.optional) };
    if (run.clarification) run.replies.push({ intent: 'clarification', content: run.clarification, confidence: 0.3, state: run.current });
    const hint = run.old && !run.consumed && run.old.kind !== 'proposal_choice' ? this.helpers.pending.droppedHint(run.old) : null;
    if (hint) run.replies.push({ intent: 'clarification', content: `_Hinweis: ${hint}_`, state: run.current });
    if (run.deferred.length) {
      run.current = { ...run.current, queue: run.deferred };
      run.replies.push({
        intent: 'clarification',
        content: `Danach erledige ich noch:\n${run.deferred.map((d) => `• ${describeIntent(d.intent)}`).join('\n')}`,
        state: run.current,
      });
    }
    if (!run.replies.length) return { intent: 'unknown', content: 'Okay.', confidence: 0.3, state: run.current };
    return mergeReplies(run.replies, run.current);
  }
}

/** „Thema oder Projekt?“ takes precedence; several new open items of one message are asked about together („für alle drei 31.12.“). */
function holdOptional(run: WorkRun): void {
  const pending = run.current.pending;
  if ((pending?.kind !== 'open_item' && pending?.kind !== 'decision') || !pending.optional) return;
  if (run.optional?.kind === 'open_item' && pending.kind === 'open_item')
    run.optional = openItemPending([...openItemAsks(run.optional), ...openItemAsks(pending)], true);
  else if (run.optional?.kind !== 'decision') run.optional = pending;
  run.current = { ...run.current, pending: null };
}
