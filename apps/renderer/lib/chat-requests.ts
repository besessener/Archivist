import type { ChatMsg } from './types';

/** Ergebnis von `chat:send` (nur die Felder, die die Oberfläche braucht). */
export interface ChatSendOutcome {
  conversationId: string;
  userMessage: ChatMsg;
  assistantMessage: ChatMsg;
}

/** Eine abgeschickte Chat-Anfrage, deren Antwort noch nicht in der geladenen Historie steht. */
export interface ChatRequest {
  /** Temporäre ID (zugleich ID der vorläufigen Benutzernachricht, beginnt mit `pending-`). */
  id: string;
  /** Unterhaltung der Anfrage; `null` = neue Unterhaltung, deren ID erst mit der Antwort bekannt wird. */
  conversationId: string | null;
  /** Vorläufige Benutzernachricht, bis die gespeicherte Nachricht in der Historie steht. */
  message: ChatMsg;
  /** Gespeicherte Nachrichten, sobald die Antwort da ist (bis die Historie sie enthält). */
  result: [ChatMsg, ChatMsg] | null;
}

export interface ChatRequestState {
  requests: ChatRequest[];
  /** Angezeigte Unterhaltung; `undefined` = noch nicht gewählt (dann die zuletzt aktive). Überdauert einen Seitenwechsel. */
  activeConversationId: string | null | undefined;
}

/**
 * Hält laufende Chat-Anfragen außerhalb der Chat-Seite. Die Anfrage selbst läuft im Hauptprozess weiter,
 * wenn der Benutzer den Reiter wechselt; dieser Speicher sorgt dafür, dass die Chat-Seite nach der Rückkehr
 * die laufende Anfrage („Archivist denkt nach …“) und danach die Antwort in der richtigen Unterhaltung zeigt.
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
     * Schickt eine Nachricht über `sendFn` ab und merkt sie sich, bis die Antwort da ist.
     * `sendFn` liefert `undefined` bei einem Fehler (der Aufrufer zeigt ihn an); dann wird die Anfrage verworfen.
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
      // Eine neue Unterhaltung bleibt im Blick, solange der Benutzer nicht zu einer anderen gewechselt ist.
      if (conversationId === null && state.activeConversationId === null) update({ ...state, activeConversationId: res.conversationId });
      patchRequest(id, { conversationId: res.conversationId, result: [res.userMessage, res.assistantMessage] });
      return res;
    },
    /** Vergisst beantwortete Anfragen, deren Antwort in der geladenen Historie steht. */
    settle(history: ChatMsg[]) {
      const ids = new Set(history.map((m) => m.id));
      const done = state.requests.filter((r) => r.result && ids.has(r.result[1].id));
      if (done.length > 0) update({ ...state, requests: state.requests.filter((r) => !done.includes(r)) });
    },
  };
}

/** Anfragen einer Unterhaltung (`null` = neue Unterhaltung). */
export function requestsFor(requests: ChatRequest[], conversationId: string | null): ChatRequest[] {
  return requests.filter((r) => r.conversationId === conversationId);
}

/**
 * Führt die geladene Historie mit den Anfragen der Unterhaltung zusammen: beantwortete Anfragen liefern ihre
 * gespeicherten Nachrichten, laufende ihre vorläufige Benutzernachricht – außer der Hauptprozess hat sie
 * schon gespeichert und die Historie enthält sie (gleicher Text, nicht älter als die Anfrage).
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

/** Gemeinsamer Speicher der App (lebt so lange wie das Fenster, nicht nur so lange wie die Chat-Seite). */
export const chatRequests = createChatRequestStore();
