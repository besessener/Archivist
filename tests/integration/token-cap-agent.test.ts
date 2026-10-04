import { afterEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../helpers/harness';
import { agentApp, scriptedTurns } from '../helpers/agent';

const PROVIDERS = [
  { name: 'OpenAI-compatible (Responses API)', opts: {} },
  { name: 'Claude (Messages API)', opts: { baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5' } },
] as const;

describe.each(PROVIDERS)('daily token limit in agent runs via $name (#153)', ({ opts }) => {
  let app: TestApp;
  afterEach(async () => {
    await app.cleanup();
  });

  it('stops a run started below the limit before the next turn goes out once a turn reaches it', async () => {
    app = await agentApp(opts);
    await app.ok('settings:update', { llm: { dailyTokenCap: 1000 } });
    app.llm.agent = scriptedTurns({ calls: [{ name: 'find_documents', args: { ext: ['md'] } }], usage: { input: 1500, output: 20 } }, { text: 'Fertig.' });

    const res = await app.ok('chat:send', { text: 'Finde alle md-Dateien' });

    const run = await app.ok('agent:run', { id: res.assistantMessage.runId! });
    expect(run).toMatchObject({ status: 'error', error: expect.stringMatching(/Tageslimit von 1\.000 Tokens/) });
    expect(run.usage.requests).toBe(1);
  });

  it('keeps going once the user chose to continue despite the limit', async () => {
    app = await agentApp(opts);
    app.llm.agent = scriptedTurns({ text: 'Viel verbraucht.', usage: { input: 1500, output: 20 } });
    const first = await app.ok('chat:send', { text: 'Hallo' });
    await app.ok('settings:update', { llm: { dailyTokenCap: 1000 } });
    expect((await app.ok('chat:send', { text: 'Noch etwas', conversationId: first.conversationId })).assistantMessage.intent).toBe('token_cap');
    app.llm.agent = scriptedTurns({ calls: [{ name: 'find_documents', args: { ext: ['md'] } }] }, { text: 'Fertig.' });

    const continued = await app.ok('chat:send', { text: 'Trotzdem fortfahren', conversationId: first.conversationId });

    expect(await app.ok('agent:run', { id: continued.assistantMessage.runId! })).toMatchObject({ status: 'done', usage: { requests: 2 } });
  });
});
