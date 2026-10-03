import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ configured: false });
});
afterEach(async () => {
  await app.cleanup();
});

const send = (text: string) => app.ok('chat:send', { text });

describe('chat without a configured LLM (#248)', () => {
  it.each(['Wo ist mein Mietvertrag', 'Zeig mir den Mietvertrag', 'Finde den Mietvertrag'])('does not save the search "%s" as a note', async (text) => {
    const reply = await send(text);
    expect(reply.assistantMessage.content).not.toContain('Notiz gespeichert');
    expect(reply.assistantMessage.intent).not.toBe('note_capture');
  });

  it('points out the missing LLM without showing it as an error', async () => {
    const reply = await send('Wo ist mein Mietvertrag');
    expect(reply.assistantMessage.content).toContain('regelbasiert');
    expect(reply.assistantMessage.errorMessage).toBeFalsy();
  });

  it('mentions the missing LLM once per conversation', async () => {
    const first = await app.ok('chat:send', { text: 'Wo ist mein Mietvertrag' });
    const second = await app.ok('chat:send', { text: 'Wo ist mein Kaufvertrag', conversationId: first.conversationId });
    expect(first.assistantMessage.content).toContain('regelbasiert');
    expect(second.assistantMessage.content).not.toContain('regelbasiert');
  });
});
