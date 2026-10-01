import { describe, expect, it } from 'vitest';
import { createChatRequestStore, mergeChatMessages, requestsFor, type ChatSendOutcome } from '../../apps/renderer/lib/chat-requests';
import type { ChatMsg } from '../../apps/renderer/lib/types';

const msg = (overrides: Partial<ChatMsg>): ChatMsg => ({
  id: 'm1',
  conversationId: 'c1',
  role: 'user',
  content: 'Hallo',
  createdAt: '2026-10-01T10:00:00.000Z',
  sources: [],
  context: null,
  actions: [],
  confidence: null,
  uncertainties: [],
  intent: null,
  errorMessage: null,
  quickReplies: [],
  ...overrides,
});

/** Eine von außen auflösbare Antwort, um eine noch laufende Anfrage nachzubilden. */
function deferred() {
  let resolve!: (v: ChatSendOutcome | undefined) => void;
  const promise = new Promise<ChatSendOutcome | undefined>((r) => (resolve = r));
  return { promise, resolve };
}

const outcome = (conversationId: string, text = 'Hallo'): ChatSendOutcome => ({
  conversationId,
  userMessage: msg({ id: 'u1', conversationId, content: text, createdAt: new Date(Date.now() + 1000).toISOString() }),
  assistantMessage: msg({ id: 'a1', conversationId, role: 'assistant', content: 'Antwort', createdAt: new Date(Date.now() + 2000).toISOString() }),
});

describe('Chat-Anfragen außerhalb der Chat-Seite', () => {
  it('eine laufende Anfrage bleibt sichtbar, bis die Antwort da ist, und wird nicht verworfen', async () => {
    const store = createChatRequestStore();
    store.setActiveConversation('c1');
    const d = deferred();
    const done = store.send('c1', 'Hallo', () => d.promise);

    // Die Seite kann jederzeit (z. B. nach einem Reiterwechsel) neu aufgebaut werden und liest den Stand aus dem Speicher
    const running = requestsFor(store.getSnapshot().requests, 'c1');
    expect(running).toHaveLength(1);
    expect(running[0]!.result).toBeNull();
    expect(mergeChatMessages([], running).map((m) => m.content)).toEqual(['Hallo']);

    d.resolve(outcome('c1'));
    await done;
    const answered = requestsFor(store.getSnapshot().requests, 'c1');
    expect(answered[0]!.result?.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(mergeChatMessages([], answered).map((m) => m.id)).toEqual(['u1', 'a1']);

    // Sobald die Historie die Antwort enthält, ist die Anfrage erledigt
    store.settle([answered[0]!.result![0], answered[0]!.result![1]]);
    expect(store.getSnapshot().requests).toHaveLength(0);
  });

  it('eine neue Unterhaltung wird nach der Antwort gewählt, außer der Benutzer hat inzwischen eine andere gewählt', async () => {
    const store = createChatRequestStore();
    store.setActiveConversation(null);
    const first = deferred();
    const done = store.send(null, 'Hallo', () => first.promise);
    expect(requestsFor(store.getSnapshot().requests, null)).toHaveLength(1);
    first.resolve(outcome('neu'));
    await done;
    expect(store.getSnapshot().activeConversationId).toBe('neu');
    expect(requestsFor(store.getSnapshot().requests, 'neu')).toHaveLength(1);

    const other = createChatRequestStore();
    other.setActiveConversation(null);
    const second = deferred();
    const done2 = other.send(null, 'Hallo', () => second.promise);
    other.setActiveConversation('alt');
    second.resolve(outcome('neu'));
    await done2;
    expect(other.getSnapshot().activeConversationId).toBe('alt');
  });

  it('bei einem Fehler wird die Anfrage entfernt', async () => {
    const store = createChatRequestStore();
    await expect(store.send('c1', 'Hallo', () => Promise.resolve(undefined))).resolves.toBeUndefined();
    await expect(store.send('c1', 'Hallo', () => Promise.reject(new Error('weg')))).resolves.toBeUndefined();
    expect(store.getSnapshot().requests).toHaveLength(0);
  });

  it('meldet Änderungen an Abonnenten und lässt sich abbestellen', () => {
    const store = createChatRequestStore();
    let calls = 0;
    const off = store.subscribe(() => (calls += 1));
    store.setActiveConversation('c1');
    store.setActiveConversation('c1');
    off();
    store.setActiveConversation('c2');
    expect(calls).toBe(1);
  });

  it('die vorläufige Nachricht verschwindet, sobald die Historie die gespeicherte Nachricht enthält', async () => {
    const store = createChatRequestStore();
    const d = deferred();
    void store.send('c1', 'Hallo', () => d.promise);
    const [request] = store.getSnapshot().requests;
    const later = new Date(Date.parse(request!.message.createdAt) + 5).toISOString();
    // Eine ältere Nachricht mit gleichem Text zählt nicht als gespeicherte Anfrage
    const older = msg({ id: 'alt', content: 'Hallo', createdAt: '2020-01-01T00:00:00.000Z' });
    expect(mergeChatMessages([older], [request!]).map((m) => m.id)).toEqual(['alt', request!.id]);
    const saved = msg({ id: 'u1', content: 'Hallo', createdAt: later });
    expect(mergeChatMessages([older, saved], [request!]).map((m) => m.id)).toEqual(['alt', 'u1']);
    d.resolve(undefined);
  });
});
