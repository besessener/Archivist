import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { intent } from '../helpers/chat-intents';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

describe('Chat requests of one conversation (#251)', () => {
  it('run one after the other, so the second sees what the first saved', async () => {
    app.llm.on('ChatIntent', async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return intent({ intent: 'smalltalk' });
    });
    const first = await app.ok('chat:send', { text: 'Hallo' });
    const [a, b] = await Promise.all([
      app.ok('chat:send', { text: 'Erste', conversationId: first.conversationId }),
      app.ok('chat:send', { text: 'Zweite', conversationId: first.conversationId }),
    ]);
    const order = (await app.ok('chat:history', { conversationId: first.conversationId })).map((m) => m.content.slice(0, 6));
    expect(a.assistantMessage.id).not.toBe(b.assistantMessage.id);
    expect(order.indexOf('Zweite')).toBeGreaterThan(order.indexOf('Erste') + 1);
  });
});
