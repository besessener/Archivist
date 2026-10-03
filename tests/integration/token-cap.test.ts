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

const ask = { instructions: 'Test', input: 'Hallo', purpose: 'Limit' };

/** Spends 2000 tokens today and sets the daily limit to 1000. */
async function reachCap(cap: number | null = 1000) {
  app.llm.textUsage = { input: 1500, output: 500, cached: 0 };
  await app.services.llm.complete({ ...ask, purpose: 'Verbrauch' });
  app.llm.textUsage = { input: 10, output: 5, cached: 0 };
  await app.ok('settings:update', { llm: { dailyTokenCap: cap } });
}

describe('daily token limit (#153)', () => {
  it('is off by default: nothing is blocked however much was used', async () => {
    app.llm.textUsage = { input: 5_000_000, output: 0, cached: 0 };
    await app.services.llm.complete(ask);

    await expect(app.services.llm.complete(ask)).resolves.toBe('OK');
    expect(app.services.llm.canUseInBackground()).toBe(true);
    expect(await app.ok('llm:usage', {})).toMatchObject({ dailyCap: null, capReached: false });
  });

  it('blocks further requests once the tokens of today reach the limit, before anything is sent', async () => {
    await reachCap();
    const sent = app.llm.textBodies.length;

    await expect(app.services.llm.complete(ask)).rejects.toMatchObject({
      message: expect.stringMatching(/Tageslimit/),
      category: 'llm_error',
      retryable: false,
    });

    expect(app.llm.textBodies).toHaveLength(sent);
    expect(await app.ok('llm:usage', {})).toMatchObject({ dailyCap: 1000, capReached: true });
  });

  it('lets requests through below the limit and the explicit connection test always', async () => {
    await reachCap(2001);
    await expect(app.services.llm.complete(ask)).resolves.toBe('OK');

    await app.ok('settings:update', { llm: { dailyTokenCap: 1000 } });
    expect((await app.ok('llm:testConnection', {})).ok).toBe(true);
  });

  it('keeps background features off while the limit is reached, and on again once it is raised', async () => {
    await reachCap();
    expect(app.services.llm.canUseInBackground()).toBe(false);
    expect(app.services.llm.canUse()).toBe(true);

    await app.ok('settings:update', { llm: { dailyTokenCap: null } });
    expect(app.services.llm.canUseInBackground()).toBe(true);
  });

  it('does not send embeddings past the limit', async () => {
    app.services.settings.update({ llm: { embeddingModel: 'emb' } });
    app.llm.embed = (texts) => texts.map(() => [0.1]);
    await reachCap();

    await expect(app.services.llm.embeddings(['Text'], { purpose: 'Vektoren' })).rejects.toThrow(/Tageslimit/);
    expect(app.llm.embeddingRequests).toHaveLength(0);
  });

  it('only counts the tokens of today', async () => {
    await reachCap();
    app.services.ctx.database.db.run(`update llm_transmissions set at = '2020-01-01T00:00:00.000Z'`);

    await expect(app.services.llm.complete(ask)).resolves.toBe('OK');
  });
});

describe('daily token limit: background jobs pause (#153)', () => {
  const classification = {
    docType: 'Notiz',
    title: 'Eine Notiz',
    summary: 'Kurz.',
    persons: [],
    dates: [],
    tags: [],
    location: { categoryPath: 'misc', fileName: null, newMainCategory: false, rationale: 'x', confidence: 0.8 },
    decisions: [],
    openItems: [],
    confidence: 0.8,
    rationale: 'x',
  };

  it('keeps the analysis pending without using an attempt, then finishes it once the limit is raised', async () => {
    app.llm.on('DocumentClassification', () => classification);
    await reachCap();
    const callsBefore = app.llm.calls.length;
    const source = app.file('Downloads/notiz.txt', 'Eine kurze Notiz zum Test.');

    const { imported } = await app.ok('documents:import', { paths: [source] });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const [job] = await app.ok('jobs:list', {});
    expect(job).toMatchObject({ type: 'document.analyze', status: 'pending', attempts: 0, error: null, progressMessage: expect.stringMatching(/Tageslimit/) });
    expect((await app.ok('documents:get', { id: imported[0]!.id })).status).toBe('analyzing');
    expect(app.llm.calls).toHaveLength(callsBefore);

    await app.ok('settings:update', { llm: { dailyTokenCap: null } });
    await app.services.jobs.whenIdle();

    const doc = await app.ok('documents:get', { id: imported[0]!.id });
    expect(doc.status).toBe('proposed');
    expect((await app.ok('jobs:list', {}))[0]).toMatchObject({ status: 'succeeded' });
  });

  it('does not resume while the limit still applies after a change of it', async () => {
    app.llm.on('DocumentClassification', () => classification);
    await reachCap();
    await app.ok('documents:import', { paths: [app.file('Downloads/notiz.txt', 'Eine kurze Notiz zum Test.')] });
    await new Promise((resolve) => setTimeout(resolve, 300));

    await app.ok('settings:update', { llm: { dailyTokenCap: 1500 } });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect((await app.ok('jobs:list', {}))[0]).toMatchObject({ status: 'pending', attempts: 0 });
  });
});

describe('daily token limit: the chat asks first (#153)', () => {
  const send = (text: string, conversationId?: string) => app.ok('chat:send', { text, conversationId });

  beforeEach(() => {
    app.llm.on('ChatIntent', () => intent({ intent: 'smalltalk' }));
  });

  it('holds the message back with a question, and continues on request for the rest of the day', async () => {
    await reachCap();
    const before = app.llm.calls.length;

    const asked = await send('Wie geht es dir?');
    expect(asked.assistantMessage).toMatchObject({
      intent: 'token_cap',
      quickReplies: ['Trotzdem fortfahren'],
      content: expect.stringMatching(/Tageslimit von 1\.000 Tokens/),
    });
    expect(app.llm.calls).toHaveLength(before);

    const continued = await send('Trotzdem fortfahren', asked.conversationId);
    expect(continued.assistantMessage.intent).not.toBe('token_cap');
    expect(app.llm.calls.length).toBeGreaterThan(before);

    const later = await send('Noch eine Frage', asked.conversationId);
    expect(later.assistantMessage.intent).not.toBe('token_cap');
  });

  it('asks again in a new conversation, because the choice belongs to the conversation', async () => {
    await reachCap();
    const first = await send('Hallo');
    await send('Trotzdem fortfahren', first.conversationId);

    expect((await send('Hallo noch einmal')).assistantMessage.intent).toBe('token_cap');
  });

  it('does not ask without a reached limit', async () => {
    expect((await send('Hallo')).assistantMessage.intent).not.toBe('token_cap');
  });
});
