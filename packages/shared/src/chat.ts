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
