import type { ChatIntent, OpenItem, StoredAgentAction } from '@archivist/shared';
import type { AppContext } from '../context';
import { AppError } from '../util/errors';
import type { ActionService } from './actions';
import { conversationState, type ConvState, type OpenItemField, type OpenItemPending, type Pending, type Reply } from './chat-state';
import type { CaptureDeps, CaptureRequest } from './capture/capture-deps';
import { DecisionCapture } from './capture/decision-capture';
import { DecisionSupersede } from './capture/decision-supersede';
import { captureNote, recordEvent } from './capture/note-event-capture';
import { OpenItemCapture } from './capture/open-item-capture';
import { OpenItemLookup } from './capture/open-item-lookup';
import { ReminderCapture } from './capture/reminder-capture';

const CAPTURE_INTENTS = new Set<ChatIntent['intent']>([
  'decision_new',
  'decision_amend',
  'decision_supersede',
  'event_record',
  'note_capture',
  'open_item_new',
  'open_item_update',
  'open_item_close',
  'reminder_create',
  'reminder_snooze',
]);

/** Outcome of a capture request for the agent tools (#307): the reply, proposal cards and the handler's follow-up question. */
export interface CaptureResult {
  content: string;
  /** Proposal cards the handler created (e.g. „ältere Entscheidung als überholt markieren?“). */
  actionIds: string[];
  /** The handler would have asked this (required field, duplicate …). */
  question: string | null;
  decisionId: string | null;
  openItemId: string | null;
  /** Older decisions the new one may replace when the hint was not unique („Welche Entscheidung wird ersetzt?“). */
  supersedeCandidateIds: string[];
}

export type CaptureServiceDeps = Omit<CaptureDeps, 'actions'>;

/** Capturing knowledge (#307) for the agent's tools and the rule-based chat (which keeps follow-up questions in its state). */
export class CaptureService {
  private actions!: ActionService;
  private readonly deps: CaptureDeps;
  private readonly lookup: OpenItemLookup;
  private readonly supersede: DecisionSupersede;
  private readonly decisionCapture: DecisionCapture;
  private readonly openItemCapture: OpenItemCapture;
  private readonly reminderCapture: ReminderCapture;

  private readonly ctx: AppContext;

  constructor(deps: CaptureServiceDeps) {
    this.ctx = deps.ctx;
    this.deps = { ...deps, actions: () => this.actions };
    this.lookup = new OpenItemLookup(deps.openItems);
    this.supersede = new DecisionSupersede(this.deps);
    this.decisionCapture = new DecisionCapture(this.deps, this.supersede);
    this.openItemCapture = new OpenItemCapture(this.deps, this.lookup);
    this.reminderCapture = new ReminderCapture(this.deps, this.lookup);
  }

  wire(deps: { actions: ActionService }): void {
    this.actions = deps.actions;
  }

  /** One capture request of the agent: the handler of the intent, with the conversation's last items as context. */
  async forAgent({
    conversationId,
    text,
    intent,
    ...options
  }: {
    conversationId: string | null;
    text: string;
    intent: ChatIntent;
    force?: boolean;
  }): Promise<CaptureResult> {
    const state: ConvState = { last: conversationId ? conversationState(this.ctx.database.db, conversationId).last : undefined };
    const reply = await this.handle({ conv: conversationId ?? '', text, intent, state }, { viaLlm: true, force: options.force });
    const pending = reply.state?.pending ?? null;
    return {
      content: reply.content,
      actionIds: (reply.actions ?? []).map((action) => action.id),
      question: pending && !(pending.kind === 'open_item' && pending.optional) ? reply.content : null,
      decisionId: reply.state?.last?.decisionId ?? null,
      openItemId: pending?.kind === 'open_item_duplicate' ? null : (reply.state?.last?.openItemId ?? null),
      supersedeCandidateIds: pending?.kind === 'supersede_choice' ? pending.candidateIds : [],
    };
  }

  /** The agent's answer to „Welche Entscheidung wird ersetzt?“: the same proposal card as the chat's (confirmation required). */
  proposeSupersedeOf(conversationId: string | null, ids: { olderId: string; newerId: string }): StoredAgentAction {
    return this.supersede.proposeSupersedeOf(conversationId ?? '', ids);
  }

  /** Is this a capture request? (the chat's dispatch hands those over to `handle`) */
  static handles(intent: ChatIntent['intent']): boolean {
    return CAPTURE_INTENTS.has(intent);
  }

  /** Runs a capture request; `state.pending` is set only when the request answers the open follow-up question. */
  handle(request: CaptureRequest, options: { viaLlm: boolean; force?: boolean }): Promise<Reply> {
    const { intent } = request;
    switch (intent.intent) {
      case 'decision_new':
      case 'decision_amend':
      case 'decision_supersede':
        return this.decisionCapture.flow(request, { viaLlm: options.viaLlm });
      case 'event_record':
        return recordEvent(this.deps, request);
      case 'note_capture':
        return captureNote(this.deps, request);
      case 'open_item_new':
        return options.force ? this.openItemCapture.createDespiteDuplicate(request) : this.openItemCapture.create(request);
      case 'open_item_update':
        return this.openItemCapture.update(request);
      case 'open_item_close':
        return this.openItemCapture.close(request);
      case 'reminder_create':
      case 'reminder_snooze':
        return this.reminderCapture.capture(request);
      default:
        throw new AppError('validation_error', `Kein Erfassungs-Anliegen: ${intent.intent}`);
    }
  }

  /** Answer to „Welche Entscheidung wird ersetzt?“: number, „keine“, or title or topic. Otherwise null. */
  answerSupersedeChoice(request: Omit<CaptureRequest, 'intent'>, pending: Extract<Pending, { kind: 'supersede_choice' }>): Reply | null {
    return this.supersede.answerChoice(request, pending);
  }

  /** Answer to „Gibt es schon: ‚…‘ – ergänzen oder neu anlegen?“. Otherwise null. */
  answerOpenItemDuplicate(request: Omit<CaptureRequest, 'intent'>, pending: Extract<Pending, { kind: 'open_item_duplicate' }>): Promise<Reply | null> {
    return this.openItemCapture.answerDuplicate(request, pending);
  }

  openItemOrNull(id: string | null | undefined): OpenItem | null {
    return this.lookup.openItemOrNull(id);
  }

  /** Items of an open-item follow-up question that still lack an asked field – answered, closed or deleted ones drop out. */
  openItemGroup(pending: OpenItemPending): Array<{ item: OpenItem; asked: OpenItemField[] }> {
    return this.lookup.openItemGroup(pending);
  }

  answerOpenItemChoice(text: string, pending: Extract<Pending, { kind: 'open_item_choice' }>): OpenItem | null {
    return this.lookup.answerOpenItemChoice(text, pending);
  }
}
