import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const latest = async (purpose: string) => (await app.ok('llm:transmissions', { limit: 50 })).find((entry) => entry.purpose === purpose);
const ask = { instructions: 'Test', input: 'Hallo', purpose: 'Nutzung' };

describe('token accounting in the transmission log (#153)', () => {
  it('stores the tokens the endpoint reports for a plain answer, cached tokens separately', async () => {
    app.llm.textUsage = { input: 120, output: 30, cached: 80 };

    await app.services.llm.complete(ask);

    expect(await latest('Nutzung')).toMatchObject({ inputTokens: 120, cacheReadTokens: 80, outputTokens: 30, requests: 1, success: true });
  });

  it('stores them for a structured answer, too', async () => {
    app.llm.on('Probe', () => ({ ok: true }));

    await app.services.llm.completeJson(z.object({ ok: z.boolean() }), { ...ask, purpose: 'Struktur', schemaName: 'Probe' });

    expect(await latest('Struktur')).toMatchObject({ inputTokens: 10, outputTokens: 5, requests: 1 });
  });

  it('stores the tokens of embeddings as input tokens', async () => {
    app.services.settings.update({ llm: { embeddingModel: 'emb' } });
    app.llm.embed = (texts) => texts.map(() => [0.1, 0.2]);
    app.llm.textUsage = { input: 42, output: 0, cached: 0 };

    await app.services.llm.embeddings(['ein Text'], { purpose: 'Vektoren' });

    expect(await latest('Vektoren')).toMatchObject({ inputTokens: 42, outputTokens: 0, requests: 1 });
  });

  it('stores the tokens of a plain answer given through Claude', async () => {
    app.services.settings.update({ llm: { baseUrl: 'https://llm.example.test/anthropic' } });
    app.llm.textUsage = { input: 77, output: 11, cached: 0 };

    await app.services.llm.complete(ask);

    expect(await latest('Nutzung')).toMatchObject({ inputTokens: 77, outputTokens: 11, requests: 1, endpoint: expect.stringContaining('Messages API') });
  });

  it('counts every attempt of one transmission and keeps it a single entry', async () => {
    app.llm.status = 500;

    await expect(app.services.llm.complete(ask)).rejects.toThrow();

    const entries = (await app.ok('llm:transmissions', { limit: 50 })).filter((entry) => entry.purpose === 'Nutzung');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ success: false, requests: 3, inputTokens: null });
  });

  it('counts a resend without a rejected optional parameter as a request', async () => {
    app.services.settings.update({ llm: { reasoningEffort: 'high' } });
    app.llm.rejectEfforts = ['high'];

    await app.services.llm.complete(ask);

    expect(await latest('Nutzung')).toMatchObject({ requests: 2, success: true, inputTokens: 10 });
  });

  it('sums today and the month for the privacy tab', async () => {
    await app.services.llm.complete(ask);
    await app.services.llm.complete(ask);

    const usage = await app.ok('llm:usage', {});

    expect(usage.today).toEqual({ inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, totalTokens: 30, requests: 2 });
    expect(usage.month.totalTokens).toBe(30);
    expect(usage).toMatchObject({ dailyCap: null, capReached: false });
  });

  it('does not count entries from before today in the daily total', async () => {
    await app.services.llm.complete(ask);
    app.services.ctx.database.db.run(`update llm_transmissions set at = '2020-01-01T00:00:00.000Z'`);

    const usage = await app.ok('llm:usage', {});

    expect(usage.today.totalTokens).toBe(0);
    expect(usage.month.totalTokens).toBe(0);
  });
});
