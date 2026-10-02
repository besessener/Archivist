import type { ChatMsg } from './types';

/** Result of `chat:send` (only the fields the UI needs). */
export interface ChatSendOutcome {
  conversationId: string;
  userMessage: ChatMsg;
  assistantMessage: ChatMsg;
}

/** A sent chat request whose reply is not yet in the loaded history. */
export interface ChatRequest {
  /** Temporary ID (also the ID of the provisional user message, starts with `pending-`). */
  id: string;
  /** Conversation of the request; `null` = new conversation whose ID only becomes known with the reply. */
  conversationId: string | null;
  /** Provisional user message until the saved message is in the history. */
  message: ChatMsg;
  /** Saved messages once the reply has arrived (until the history contains them). */
  result: [ChatMsg, ChatMsg] | null;
}

export interface ChatRequestState {
  requests: ChatRequest[];
  /** Displayed conversation; `undefined` = not chosen yet (then the most recently active one). Survives a page change. */
  activeConversationId: string | null | undefined;
}

/**
 * Keeps running chat requests outside the chat page. The request itself keeps running in the main process
 * when the user switches tabs; this store ensures that after returning, the chat page shows the running
 * request („Archivist denkt nach …“) and then the reply in the right conversation.
 */
export function createChatRequestStore() {
  let state: ChatRequestState = { requests: [], activeConversationId: undefined };
  const listeners = new Set<() => void>();
  let counter = 0;

  const update = (next: ChatRequestState) => {
    state = next;
    for (const l of listeners) l();
  };
  const patchRequest = (id: string, patch: Partial<ChatRequest>) =>
    update({ ...state, requests: state.requests.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  const removeRequest = (id: string) => update({ ...state, requests: state.requests.filter((r) => r.id !== id) });

  return {
    getSnapshot: (): ChatRequestState => state,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setActiveConversation(id: string | null) {
      if (state.activeConversationId !== id) update({ ...state, activeConversationId: id });
    },
    /**
     * Sends a message via `sendFn` and remembers it until the reply has arrived.
     * `sendFn` returns `undefined` on an error (the caller shows it); the request is then discarded.
     */
    async send(conversationId: string | null, content: string, sendFn: () => Promise<ChatSendOutcome | undefined>): Promise<ChatSendOutcome | undefined> {
      const now = new Date();
      const id = `pending-${now.getTime()}-${++counter}`;
      const message: ChatMsg = {
        id,
        conversationId: conversationId ?? 'pending',
        role: 'user',
        content,
        createdAt: now.toISOString(),
        sources: [],
        context: null,
        actions: [],
        confidence: null,
        uncertainties: [],
        intent: null,
        errorMessage: null,
        quickReplies: [],
      };
      update({ ...state, requests: [...state.requests, { id, conversationId, message, result: null }] });
      let res: ChatSendOutcome | undefined;
      try {
        res = await sendFn();
      } catch {
        res = undefined;
      }
      if (!res) {
        removeRequest(id);
        return undefined;
      }
      // A new conversation stays in view as long as the user has not switched to another one.
      if (conversationId === null && state.activeConversationId === null) update({ ...state, activeConversationId: res.conversationId });
      patchRequest(id, { conversationId: res.conversationId, result: [res.userMessage, res.assistantMessage] });
      return res;
    },
    /** Forgets answered requests whose reply is in the loaded history. */
    settle(history: ChatMsg[]) {
      const ids = new Set(history.map((m) => m.id));
      const done = state.requests.filter((r) => r.result && ids.has(r.result[1].id));
      if (done.length > 0) update({ ...state, requests: state.requests.filter((r) => !done.includes(r)) });
    },
  };
}

/** Requests of a conversation (`null` = new conversation). */
export function requestsFor(requests: ChatRequest[], conversationId: string | null): ChatRequest[] {
  return requests.filter((r) => r.conversationId === conversationId);
}

/**
 * Merges the loaded history with the conversation's requests: answered requests contribute their
 * saved messages, running ones their provisional user message – unless the main process has already
 * saved it and the history contains it (same text, not older than the request).
 */
export function mergeChatMessages(history: ChatMsg[], requests: ChatRequest[]): ChatMsg[] {
  const out = [...history];
  const ids = new Set(history.map((m) => m.id));
  for (const r of requests) {
    if (r.result) {
      for (const m of r.result) if (!ids.has(m.id)) out.push(m);
      continue;
    }
    const saved = history.some((m) => m.role === 'user' && m.content === r.message.content && m.createdAt >= r.message.createdAt);
    if (!saved) out.push(r.message);
  }
  return out;
}

/** Shared app store (lives as long as the window, not just as long as the chat page). */
export const chatRequests = createChatRequestStore();
