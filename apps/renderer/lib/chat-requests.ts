import type { ChatMessage } from './types';

/** Result of `chat:send` (only the fields the UI needs). */
export interface ChatSendOutcome {
  conversationId: string;
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
}

/** A sent chat request whose reply is not yet in the loaded history. */
export interface ChatRequest {
  /** Temporary ID (also the ID of the provisional user message, starts with `pending-`). */
  id: string;
  /** Conversation of the request; `null` = new conversation whose ID only becomes known with the reply. */
  conversationId: string | null;
  /** Provisional user message until the saved message is in the history. */
  message: ChatMessage;
  /** Saved messages once the reply has arrived (until the history contains them). */
  result: [ChatMessage, ChatMessage] | null;
}

export interface ChatRequestState {
  requests: ChatRequest[];
  /** Displayed conversation; `undefined` = not chosen yet (then the most recently active one). Survives a page change. */
  activeConversationId: string | null | undefined;
}

/** Keeps running chat requests outside the chat page, so after switching tabs it still shows them and their replies. */
export function createChatRequestStore() {
  let state: ChatRequestState = { requests: [], activeConversationId: undefined };
  const listeners = new Set<() => void>();
  let counter = 0;

  const update = (next: ChatRequestState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const patchRequest = (id: string, patch: Partial<ChatRequest>) =>
    update({ ...state, requests: state.requests.map((request) => (request.id === id ? { ...request, ...patch } : request)) });
  const removeRequest = (id: string) => update({ ...state, requests: state.requests.filter((request) => request.id !== id) });

  return {
    getSnapshot: (): ChatRequestState => state,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setActiveConversation(id: string | null) {
      if (state.activeConversationId !== id) update({ ...state, activeConversationId: id });
    },
    /** Remembers the message until its reply arrives; `sendFn` returns `undefined` on an error it has shown, which discards it. */
    async send(
      { conversationId, content }: { conversationId: string | null; content: string },
      sendFn: () => Promise<ChatSendOutcome | undefined>,
    ): Promise<ChatSendOutcome | undefined> {
      const now = new Date();
      const id = `pending-${now.getTime()}-${++counter}`;
      const message: ChatMessage = {
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
      let outcome: ChatSendOutcome | undefined;
      try {
        outcome = await sendFn();
      } catch {
        outcome = undefined;
      }
      if (!outcome) {
        removeRequest(id);
        return undefined;
      }
      // A new conversation stays in view as long as the user has not switched to another one.
      if (conversationId === null && state.activeConversationId === null) update({ ...state, activeConversationId: outcome.conversationId });
      patchRequest(id, { conversationId: outcome.conversationId, result: [outcome.userMessage, outcome.assistantMessage] });
      return outcome;
    },
    /** Forgets answered requests whose reply is in the loaded history. */
    settle(history: ChatMessage[]) {
      const ids = new Set(history.map((message) => message.id));
      const done = state.requests.filter((request) => request.result && ids.has(request.result[1].id));
      if (done.length > 0) update({ ...state, requests: state.requests.filter((request) => !done.includes(request)) });
    },
  };
}

/** Requests of a conversation (`null` = new conversation). */
export function requestsFor(requests: ChatRequest[], conversationId: string | null): ChatRequest[] {
  return requests.filter((request) => request.conversationId === conversationId);
}

/** History plus the requests' saved replies, or their provisional message until the history holds it (same text, not older). */
export function mergeChatMessages(history: ChatMessage[], requests: ChatRequest[]): ChatMessage[] {
  const merged = [...history];
  const ids = new Set(history.map((message) => message.id));
  for (const request of requests) {
    if (request.result) {
      for (const message of request.result) if (!ids.has(message.id)) merged.push(message);
      continue;
    }
    const saved = history.some(
      (message) => message.role === 'user' && message.content === request.message.content && message.createdAt >= request.message.createdAt,
    );
    if (!saved) merged.push(request.message);
  }
  return merged;
}

/** Shared app store (lives as long as the window, not just as long as the chat page). */
export const chatRequests = createChatRequestStore();
