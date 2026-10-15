import { z } from 'zod';
import { EntityRef, Id, IsoDate, SourceReference } from './common';
import { StoredAgentAction } from './actions';

export const ChatContext = z.object({
  topics: z.array(EntityRef).default([]),
  projects: z.array(EntityRef).default([]),
  persons: z.array(EntityRef).default([]),
  decisions: z.array(EntityRef).default([]),
  openItems: z.array(EntityRef).default([]),
  documents: z.array(EntityRef).default([]),
  contradictions: z.array(EntityRef).default([]),
});
export type ChatContext = z.infer<typeof ChatContext>;

/** Most files one chat message can carry. */
export const CHAT_ATTACHMENT_LIMIT = 10;

/** A document the user attached to a chat message; it lives in the archive like every other imported file. */
export const ChatAttachment = z.object({ documentId: Id, name: z.string(), ext: z.string() });
export type ChatAttachment = z.infer<typeof ChatAttachment>;

/** Per picked path, in order: attached as a document, or why not. */
export const ChatAttachResult = z.array(
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('attached'), path: z.string(), attachment: ChatAttachment }),
    z.object({ kind: z.literal('rejected'), path: z.string(), reason: z.string() }),
  ]),
);
export type ChatAttachResult = z.infer<typeof ChatAttachResult>;

export const ChatSendInput = z
  .object({
    conversationId: Id.optional(),
    text: z.string().max(20000),
    attachments: z.array(Id).max(CHAT_ATTACHMENT_LIMIT).default([]),
  })
  .refine((input) => input.text.trim().length > 0 || input.attachments.length > 0, { message: 'Die Nachricht ist leer.' });
export type ChatSendInput = z.infer<typeof ChatSendInput>;

export const ChatMessage = z.object({
  id: Id,
  conversationId: Id,
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  createdAt: IsoDate,
  sources: z.array(SourceReference),
  context: ChatContext.nullable(),
  actions: z.array(StoredAgentAction),
  confidence: z.number().nullable(),
  uncertainties: z.array(z.string()),
  intent: z.string().nullable(),
  errorMessage: z.string().nullable(),
  /** Answer buttons for a follow-up question (e.g. „Entscheidung“, „Notiz“); a click sends the text. */
  quickReplies: z.array(z.string()).default([]),
  /** Agent run that produced this answer (steps, changes, undo, tokens – #300). */
  runId: z.string().nullish(),
  attachments: z.array(ChatAttachment).default([]),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const ChatSendResult = z.object({
  conversationId: Id,
  userMessage: ChatMessage,
  assistantMessage: ChatMessage,
});
export type ChatSendResult = z.infer<typeof ChatSendResult>;

export const Conversation = z.object({ id: Id, title: z.string(), createdAt: IsoDate, updatedAt: IsoDate });
export type Conversation = z.infer<typeof Conversation>;
