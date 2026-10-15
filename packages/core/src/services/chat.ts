import type { ChatAttachResult, ChatAttachment, ChatIntent, ChatMessage, Conversation } from '@archivist/shared';
import type { AppContext } from '../context';
import { AppError, toErrorInfo } from '../util/errors';
import { collectCreated, type CreatedEntry } from '../util/origin-scope';
import type { ActionService } from './actions';
import type { ArchiveService } from './archive';
import { mergeReplies, type ConvState, type Reply } from './chat-state';
import { llmCancelScope } from './llm';
import type { AgentService } from '../agent/service';
import { tokenCapOverride } from '../util/token-cap';
import { importAttachment } from './chat/attachment-import';
import { ConversationStore } from './chat/conversation-store';
import { ChatDispatcher } from './chat/dispatch';
import { ChatFlow } from './chat/flow';
import { IntentClassifier } from './chat/intent-classifier';
import { PendingQuestions } from './chat/pending-questions';
import { RuleBasedIntents } from './chat/rule-based';
import { dayKey, tokenCapGate, type CapGate } from './chat/token-cap-gate';
import type { ChatDeps, ChatTurn } from './chat/types';
import { errorDetails, WorkRunner, type ProgressLog } from './chat/work-runner';

type CreatedTogether = (entries: CreatedEntry[], message: { id: string; text: string }) => void;
type SuggestLinks = (entries: CreatedEntry[], reply: { messageId: string; conversationId: string }) => void;

type SentMessage = { conversationId: string; userMessage: ChatMessage; assistantMessage: ChatMessage };

/** What the user sends: the text and the ids of the documents attached to it. */
export interface OutgoingMessage {
  text: string;
  attachments: string[];
}

/** Collects what a reply creates; `attachments` are the documents the agent sees with the message. */
interface ReplyTarget {
  created: CreatedEntry[];
  attachments: string[];
}

export type ChatServiceDeps = Omit<ChatDeps, 'actions' | 'archive'>;

/** The chat: persistence, cancellation and replies – by the agent with a tool-calling LLM (#294), else by the rule-based flow in `chat/`. */
export class ChatService {
  private actions!: ActionService;
  private flow!: ChatFlow;
  private agent: AgentService | null = null;
  private createdTogether: CreatedTogether | null = null;
  private suggestLinks: SuggestLinks | null = null;
  private readonly services: Omit<ChatDeps, 'actions' | 'archive'>;
  private readonly store: ConversationStore;
  private readonly rules: RuleBasedIntents;
  private readonly progress: ProgressLog = new Map();
  /** Running requests per conversation; `cancel` aborts their LLM calls and the requests not started yet (#151). */
  private readonly running = new Map<string, AbortController>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(services: ChatServiceDeps) {
    this.services = services;
    this.store = new ConversationStore(services.ctx, () => this.actions);
    this.rules = new RuleBasedIntents(services.graph);
  }

  wire(deps: {
    actions: ActionService;
    archive: ArchiveService;
    agent?: AgentService;
    /** Entries one message created together are proposed as linked (#272). */
    createdTogether?: CreatedTogether;
    /** Link suggestions for what a message captured, attached to the reply afterwards (#283). */
    suggestLinks?: SuggestLinks;
  }): void {
    this.actions = deps.actions;
    this.agent = deps.agent ?? null;
    this.createdTogether = deps.createdTogether ?? null;
    this.suggestLinks = deps.suggestLinks ?? null;
    const all: ChatDeps = { ...this.services, actions: deps.actions, archive: deps.archive };
    const dispatcher = new ChatDispatcher(all, this.store);
    const runner = new WorkRunner(all.ctx, { dispatcher, pending: new PendingQuestions(all), progress: this.progress });
    const classifier = new IntentClassifier(all, { store: this.store, rules: this.rules });
    this.flow = new ChatFlow({ classifier, runner, dispatcher, capture: all.capture });
  }

  private get ctx(): AppContext {
    return this.services.ctx;
  }

  /** Adds proposals to an answer that is already shown (link suggestions after capturing, #283). */
  attachActions(messageId: string, actionIds: string[]): void {
    this.store.attachActions(messageId, actionIds);
  }

  listConversations(): Conversation[] {
    return this.store.list();
  }

  newConversation(title?: string): Conversation {
    return this.store.create(title);
  }

  /** Mode override of a conversation („frag mich diesmal vorher“, #298); null = the setting applies. */
  agentModeOverride(conversationId: string): 'auto' | 'ask' | null {
    return this.store.state(conversationId).agent?.mode ?? null;
  }

  setAgentModeOverride(conversationId: string, mode: 'auto' | 'ask' | null): void {
    this.store.setAgentMode(conversationId, mode);
  }

  /** Posts a message of Archivist into a conversation of its own (weekly review, #314); creates it when missing. */
  postAssistant({ title, content, existingId }: { title: string; content: string; existingId: string | null }): string {
    const conversationId = this.store.exists(existingId) ? existingId : this.store.create(title).id;
    this.store.saveAssistantMessage(conversationId, { intent: 'weekly_review', content });
    this.store.touch(conversationId);
    this.ctx.events.changed('chat');
    return conversationId;
  }

  renameConversation(id: string, title: string): Conversation {
    return this.store.rename(id, title);
  }

  /** The conversation (or, with `page`, the window of the newest messages the page names), oldest first. */
  history(conversationId: string, page?: { limit: number; offset: number }): ChatMessage[] {
    return page ? this.store.page(conversationId, page) : this.store.history(conversationId);
  }

  historyCount(conversationId: string): number {
    return this.store.count(conversationId);
  }

  /** Emergency fallback without LLM (only if the endpoint is unreachable or not configured). */
  ruleBased(text: string, state: ConvState): ChatIntent {
    return this.rules.classify(text, state);
  }

  /** Imports picked files for the next message, one after another; the result keeps the order of `paths`. */
  async attach(paths: string[]): Promise<ChatAttachResult> {
    const results: ChatAttachResult = [];
    for (const path of paths) results.push(await importAttachment(this.services.docs, path));
    return results;
  }

  /** Requests of one conversation run one after the other: each reads the state its predecessor saved (#251). */
  send(conversationId: string | undefined, message: OutgoingMessage): Promise<SentMessage> {
    if (!conversationId) return this.process(undefined, message);
    const current = (this.queues.get(conversationId) ?? Promise.resolve()).then(() => this.process(conversationId, message));
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(conversationId, settled);
    void settled.then(() => {
      if (this.queues.get(conversationId) === settled) this.queues.delete(conversationId);
    });
    return current;
  }

  private async process(conversationId: string | undefined, { text, attachments: ids }: OutgoingMessage): Promise<SentMessage> {
    const attachments = this.attachmentsOf(ids);
    const conversation = this.store.forMessage(conversationId, text.trim() || attachments.map((a) => a.name).join(', '));
    const userMessage = this.store.saveUserMessage(conversation, { text, attachments });
    // the UI already shows the message while the reply is still being produced (e.g. after switching tabs)
    this.ctx.events.changed('chat');
    const state = this.store.state(conversation);
    // everything this message creates (also before an error or a cancel) belongs together (#272)
    const created: CreatedEntry[] = [];
    const gate = this.capGate(text, state);
    // a message held at the token limit is sent later without its attachments; they stay on the saved message
    const target = { conversationId: conversation, created, attachments: gate.kind === 'proceed' && gate.text === text ? ids : [] };
    const reply = gate.kind === 'ask' ? gate.reply : await this.proceed(gate, target);
    if (created.length > 1) this.notify('Linking entries of one message failed', () => this.createdTogether?.(created, { id: userMessage.id, text }));
    const assistantMessage = this.store.saveAssistantMessage(conversation, reply);
    // never on the path of the answer: the suggestions follow in a job of their own (#283)
    if (created.length)
      this.notify('Link suggestions not started', () => this.suggestLinks?.(created, { messageId: assistantMessage.id, conversationId: conversation }));
    this.store.saveState(conversation, reply.state ?? state);
    this.ctx.events.changed('chat', 'status');
    return { conversationId: conversation, userMessage, assistantMessage };
  }

  private capGate(text: string, state: ConvState): CapGate {
    const { llm, settings } = this.services;
    const reached = llm.canUse() && llm.tokenCapReached();
    return tokenCapGate({ text, state, reached, cap: settings.get().llm.dailyTokenCap ?? null, today: dayKey(new Date()) });
  }

  /** Cancels the running request of a conversation (without id: all running requests). Returns how many were cancelled. */
  cancel(conversationId?: string): number {
    const agentRuns = this.agent?.cancel(conversationId) ?? 0;
    const targets = conversationId ? [conversationId] : [...this.running.keys()];
    let cancelled = 0;
    for (const id of targets) {
      const controller = this.running.get(id);
      if (!controller) continue;
      controller.abort();
      cancelled += 1;
    }
    return Math.max(cancelled, agentRuns);
  }

  private notify(failure: string, listener: () => void): void {
    try {
      listener();
    } catch (err) {
      this.ctx.logger.warn('chat', failure, { error: err });
    }
  }

  /** Replies past the token limit gate, ignoring the limit when the user chose to continue. */
  private proceed(gate: Extract<CapGate, { kind: 'proceed' }>, target: ReplyTarget & { conversationId: string }): Promise<Reply> {
    const reply = () => this.replyTo({ conversationId: target.conversationId, text: gate.text, state: gate.state }, target);
    return gate.override ? tokenCapOverride.run(true, reply) : reply();
  }

  /** The documents behind attached ids, in order; an unknown id fails the message before anything is saved. */
  private attachmentsOf(ids: string[]): ChatAttachment[] {
    return [...new Set(ids)].map((id) => {
      const row = this.services.docs.findRow(id);
      if (!row) throw new AppError('validation_error', 'Ein angehängtes Dokument gibt es nicht mehr.');
      return { documentId: row.id, name: row.originalName, ext: row.ext };
    });
  }

  /** The reply to a message: by the agent, else by the rule-based flow; on cancel or error what is already done stays. */
  private async replyTo(turn: ChatTurn, { created, attachments }: ReplyTarget): Promise<Reply> {
    const { conversationId } = turn;
    this.progress.set(conversationId, { replies: [], state: turn.state });
    this.running.get(conversationId)?.abort();
    const controller = new AbortController();
    this.running.set(conversationId, controller);
    try {
      const reply = async () => (await this.agentReply(turn, attachments)) ?? (await llmCancelScope.run(controller.signal, () => this.flow.handle(turn)));
      return await collectCreated(reply, created);
    } catch (err) {
      const done = this.progress.get(conversationId) ?? { replies: [], state: turn.state };
      return controller.signal.aborted ? cancelledReply(done) : this.failedReply(err, done);
    } finally {
      this.progress.delete(conversationId);
      if (this.running.get(conversationId) === controller) this.running.delete(conversationId);
    }
  }

  /** Last safeguard for errors outside the individual requests (e.g. classification): what is already done stays. */
  private failedReply(err: unknown, done: { replies: Reply[]; state: ConvState }): Reply {
    const info = toErrorInfo(err);
    this.ctx.logger.error('chat', 'Chat processing failed', { error: err });
    const failed: Reply = {
      intent: 'error',
      content: `Das konnte ich nicht verarbeiten: ${info.message}${info.retryable && !done.replies.length ? ' Bitte versuche es gleich noch einmal.' : ''}`,
      errorMessage: errorDetails(info),
      confidence: 0,
      state: done.state,
    };
    return done.replies.length ? mergeReplies([...done.replies, failed], done.state) : failed;
  }

  /** Runs the message through the agent; null when the agent cannot (then the rule-based evaluation applies). */
  private async agentReply({ conversationId, text, state }: ChatTurn, attachments: string[]): Promise<Reply | null> {
    // an open question of the rule-based flow (from before the agent mode) is still answered by that flow
    if (!this.agent || state.pending || !(await this.agent.ensureCapable())) return null;
    const result = await this.agent.chat(conversationId, { text, attachments, state: state.agent ?? {} });
    return {
      intent: 'agent',
      content: result.content,
      sources: result.sources,
      actions: this.actions.getMany(result.actionIds),
      quickReplies: result.quickReplies,
      errorMessage: result.errorMessage,
      uncertainties: result.uncertainties,
      confidence: null,
      runId: result.runId,
      state: { ...state, agent: result.state },
    };
  }
}

/** Cancelled by the user: what is already done stays, nothing else runs. */
function cancelledReply(done: { replies: Reply[]; state: ConvState }): Reply {
  const cancelled: Reply = { intent: 'cancelled', content: done.replies.length ? 'Den Rest habe ich abgebrochen.' : 'Abgebrochen.', state: done.state };
  return done.replies.length ? mergeReplies([...done.replies, cancelled], done.state) : cancelled;
}
