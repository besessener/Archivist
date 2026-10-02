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

/** An externally resolvable response, used to simulate a request that is still running. */
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

describe('chat requests outside the chat page', () => {
  it('a running request stays visible until the response arrives and is not discarded', async () => {
    const store = createChatRequestStore();
    store.setActiveConversation('c1');
    const d = deferred();
    const done = store.send('c1', 'Hallo', () => d.promise);

    // The page can be rebuilt at any time (e.g. after switching tabs) and reads the state from the store
    const running = requestsFor(store.getSnapshot().requests, 'c1');
    expect(running).toHaveLength(1);
    expect(running[0]!.result).toBeNull();
    expect(mergeChatMessages([], running).map((m) => m.content)).toEqual(['Hallo']);

    d.resolve(outcome('c1'));
    await done;
    const answered = requestsFor(store.getSnapshot().requests, 'c1');
    expect(answered[0]!.result?.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(mergeChatMessages([], answered).map((m) => m.id)).toEqual(['u1', 'a1']);

    // As soon as the history contains the response, the request is settled
    store.settle([answered[0]!.result![0], answered[0]!.result![1]]);
    expect(store.getSnapshot().requests).toHaveLength(0);
  });

  it('a new conversation is selected after the response, unless the user has selected another one in the meantime', async () => {
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

  it('on an error the request is removed', async () => {
    const store = createChatRequestStore();
    await expect(store.send('c1', 'Hallo', () => Promise.resolve(undefined))).resolves.toBeUndefined();
    await expect(store.send('c1', 'Hallo', () => Promise.reject(new Error('weg')))).resolves.toBeUndefined();
    expect(store.getSnapshot().requests).toHaveLength(0);
  });

  it('notifies subscribers of changes and supports unsubscribing', () => {
    const store = createChatRequestStore();
    let calls = 0;
    const off = store.subscribe(() => (calls += 1));
    store.setActiveConversation('c1');
    store.setActiveConversation('c1');
    off();
    store.setActiveConversation('c2');
    expect(calls).toBe(1);
  });

  it('the provisional message disappears as soon as the history contains the saved message', async () => {
    const store = createChatRequestStore();
    const d = deferred();
    void store.send('c1', 'Hallo', () => d.promise);
    const [request] = store.getSnapshot().requests;
    const later = new Date(Date.parse(request!.message.createdAt) + 5).toISOString();
    // An older message with the same text does not count as the saved request
    const older = msg({ id: 'alt', content: 'Hallo', createdAt: '2020-01-01T00:00:00.000Z' });
    expect(mergeChatMessages([older], [request!]).map((m) => m.id)).toEqual(['alt', request!.id]);
    const saved = msg({ id: 'u1', content: 'Hallo', createdAt: later });
    expect(mergeChatMessages([older, saved], [request!]).map((m) => m.id)).toEqual(['alt', 'u1']);
    d.resolve(undefined);
  });
});
