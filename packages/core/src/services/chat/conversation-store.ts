import type { ChatContext, ChatMessage, Conversation, SourceReference, StoredAgentAction } from '@archivist/shared';
import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { conversations, messages } from '../../db/schema';
import { AppError } from '../../util/errors';
import { newId, nowIso } from '../../util/ids';
import type { ArchivistJson } from '../../util/json';
import { truncate } from '../../util/text';
import type { ActionService } from '../actions';
import { conversationState, type ConvState, type Reply } from '../chat-state';

type MessageRow = typeof messages.$inferSelect;

const DEFAULT_TITLE = 'Neues Gespräch';

/** Conversations and their messages in the database; `actions` is resolved late because the chat is wired after creation. */
export class ConversationStore {
  constructor(
    private readonly ctx: AppContext,
    private readonly actions: () => ActionService,
  ) {}

  private get db() {
    return this.ctx.database.db;
  }

  list(): Conversation[] {
    return this.db
      .select()
      .from(conversations)
      .orderBy(desc(conversations.updatedAt))
      .limit(100)
      .all()
      .map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt }));
  }

  create(title = DEFAULT_TITLE): Conversation {
    const now = nowIso();
    const row = { id: newId(), title, pending: null, createdAt: now, updatedAt: now };
    this.db.insert(conversations).values(row).run();
    this.ctx.events.changed('chat');
    return { id: row.id, title, createdAt: now, updatedAt: now };
  }

  exists(id: string | null | undefined): id is string {
    return Boolean(id && this.db.select().from(conversations).where(eq(conversations.id, id)).get());
  }

  /** The conversation a message goes to: the given one if it exists, else a new one; an untitled one is named after the message. */
  forMessage(conversationId: string | undefined, text: string): string {
    const id = this.exists(conversationId) ? conversationId : this.create(truncate(text, 60)).id;
    const existing = this.db.select().from(conversations).where(eq(conversations.id, id)).get();
    if (existing?.title === DEFAULT_TITLE)
      this.db
        .update(conversations)
        .set({ title: truncate(text, 60) })
        .where(eq(conversations.id, id))
        .run();
    return id;
  }

  rename(id: string, title: string): Conversation {
    const row = this.db.select().from(conversations).where(eq(conversations.id, id)).get();
    if (!row) throw new AppError('validation_error', 'Unterhaltung nicht gefunden.');
    const clean = title.trim().replace(/\s+/g, ' ');
    if (!clean) throw new AppError('validation_error', 'Der Titel darf nicht leer sein.');
    this.db.update(conversations).set({ title: clean }).where(eq(conversations.id, id)).run();
    this.ctx.events.changed('chat');
    return { id, title: clean, createdAt: row.createdAt, updatedAt: row.updatedAt };
  }

  state(id: string): ConvState {
    return conversationState(this.db, id);
  }

  setAgentMode(conversationId: string, mode: 'auto' | 'ask' | null): void {
    const state = this.state(conversationId);
    if (!this.exists(conversationId)) throw new AppError('validation_error', 'Unterhaltung nicht gefunden.');
    this.db
      .update(conversations)
      .set({ pending: { ...state, agent: { ...(state.agent ?? {}), mode } } as unknown as ArchivistJson })
      .where(eq(conversations.id, conversationId))
      .run();
    this.ctx.events.changed('chat');
  }

  /** Stores the state after a message (follow-up question, queue, last items) and marks the conversation as updated. */
  saveState(conversationId: string, state: ConvState): void {
    this.db
      .update(conversations)
      .set({ pending: state as unknown as ArchivistJson, updatedAt: nowIso() })
      .where(eq(conversations.id, conversationId))
      .run();
  }

  touch(conversationId: string): void {
    this.db.update(conversations).set({ updatedAt: nowIso() }).where(eq(conversations.id, conversationId)).run();
  }

  history(conversationId: string): ChatMessage[] {
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt))
      .all()
      .map((r) => this.toMessage(r));
  }

  /** The newest `newest` messages, oldest first – without loading the whole conversation (#253). */
  recent(conversationId: string, newest: number): ChatMessage[] {
    return this.page(conversationId, { limit: newest, offset: 0 });
  }

  /** A window counted from the newest message (`offset` newer ones are skipped), oldest first. */
  page(conversationId: string, window: { limit: number; offset: number }): ChatMessage[] {
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.createdAt), sql`rowid desc`)
      .limit(window.limit)
      .offset(window.offset)
      .all()
      .reverse()
      .map((r) => this.toMessage(r));
  }

  count(conversationId: string): number {
    return this.db.select({ n: count() }).from(messages).where(eq(messages.conversationId, conversationId)).get()?.n ?? 0;
  }

  saveUserMessage(conversationId: string, text: string): ChatMessage {
    return this.insert(this.row(conversationId, { role: 'user', content: text }));
  }

  saveAssistantMessage(conversationId: string, reply: Reply): ChatMessage {
    return this.insert({
      ...this.row(conversationId, { role: 'assistant', content: reply.content }),
      sources: reply.sources ?? [],
      context: reply.context
        ? { topics: [], projects: [], persons: [], decisions: [], openItems: [], documents: [], contradictions: [], ...reply.context }
        : null,
      actionIds: (reply.actions ?? []).map((a) => a.id),
      confidence: reply.confidence ?? null,
      uncertainties: reply.uncertainties ?? [],
      intent: reply.intent,
      errorMessage: reply.errorMessage ?? null,
      quickReplies: reply.quickReplies ?? [],
      runId: reply.runId ?? null,
    });
  }

  attachActions(messageId: string, actionIds: string[]): void {
    const row = this.db.select().from(messages).where(eq(messages.id, messageId)).get();
    if (!row || !actionIds.length) return;
    this.db
      .update(messages)
      .set({ actionIds: [...new Set([...row.actionIds, ...actionIds])] })
      .where(eq(messages.id, messageId))
      .run();
    this.ctx.events.changed('chat');
  }

  /** Open proposals that were shown as a card in this conversation (newest first). */
  openCards(conversationId: string): StoredAgentAction[] {
    const shown = this.db
      .select({ actionIds: messages.actionIds })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), sql`json_array_length(${messages.actionIds}) > 0`))
      .orderBy(asc(messages.createdAt))
      .all()
      .flatMap((m) => m.actionIds);
    return this.actions().openInConversation(conversationId, shown);
  }

  private row(conversationId: string, message: { role: 'user' | 'assistant'; content: string }): MessageRow {
    return {
      id: newId(),
      conversationId,
      role: message.role,
      content: message.content,
      sources: [],
      context: null,
      actionIds: [],
      confidence: null,
      uncertainties: [],
      intent: null,
      errorMessage: null,
      quickReplies: [],
      runId: null,
      createdAt: nowIso(),
    };
  }

  private insert(row: MessageRow): ChatMessage {
    this.db.insert(messages).values(row).run();
    return this.toMessage(row);
  }

  private toMessage(r: MessageRow): ChatMessage {
    return {
      id: r.id,
      conversationId: r.conversationId,
      role: r.role as ChatMessage['role'],
      content: r.content,
      createdAt: r.createdAt,
      sources: r.sources as SourceReference[],
      context: (r.context as ChatContext | null) ?? null,
      actions: this.actions().getMany(r.actionIds),
      confidence: r.confidence,
      uncertainties: r.uncertainties,
      intent: r.intent,
      errorMessage: r.errorMessage,
      quickReplies: r.quickReplies,
      runId: r.runId,
    };
  }
}
