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

const Answer = z.object({ title: z.string(), tags: z.array(z.string()).default([]), note: z.string().nullish() });
const request = { instructions: 'Test', input: 'Hallo', purpose: 'Struktur', schemaName: 'Antwort' };
const formatOf = (index: number) => (app.llm.textBodies[index]?.text as { format?: Record<string, unknown> } | undefined)?.format;
const transmissions = async () => (await app.ok('llm:transmissions', { limit: 50 })).filter((entry) => entry.purpose === 'Struktur');

describe('Structured Outputs (#154)', () => {
  beforeEach(() => {
    app.llm.on('Antwort', () => ({ title: 'T', tags: [], note: null }));
  });

  it('sends the strict schema of the Zod schema as text.format json_schema', async () => {
    await expect(app.services.llm.completeJson(Answer, request)).resolves.toEqual({ title: 'T', tags: [], note: null });

    expect(formatOf(0)).toMatchObject({
      type: 'json_schema',
      name: 'Antwort',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'tags', 'note'],
        properties: { note: { type: ['string', 'null'] } },
      },
    });
    expect((await transmissions())[0]).toMatchObject({ note: null, requests: 1 });
  });

  it('names the format with a valid name', async () => {
    app.llm.raw = '{"title":"T"}';

    await app.services.llm.completeJson(Answer, { ...request, schemaName: 'Antwort mit Leerzeichen & Ö' });

    expect(formatOf(0)).toMatchObject({ name: expect.stringMatching(/^[\w-]{1,64}$/) });
  });

  it('falls back to json_object when the endpoint rejects json_schema, says so in the log and remembers it', async () => {
    app.llm.rejectJsonSchema = true;

    await expect(app.services.llm.completeJson(Answer, request)).resolves.toMatchObject({ title: 'T' });
    await expect(app.services.llm.completeJson(Answer, request)).resolves.toMatchObject({ title: 'T' });

    expect(app.llm.textBodies.map((_body, index) => formatOf(index)?.type)).toEqual(['json_schema', 'json_object', 'json_object']);
    const [second, first] = await transmissions();
    expect(first).toMatchObject({ requests: 2, success: true, note: expect.stringContaining('json_schema') });
    expect(second).toMatchObject({ requests: 1, note: expect.stringContaining('json_schema') });
  });

  it('still lets a free-form schema through with json_object, noted nowhere as a failure', async () => {
    app.llm.on('Frei', () => ({ map: { a: 'b' } }));

    await app.services.llm.completeJson(z.object({ map: z.record(z.string(), z.string()) }), { ...request, schemaName: 'Frei' });

    expect(formatOf(0)).toEqual({ type: 'json_object' });
  });

  it('validates the answer with Zod and corrects once', async () => {
    let answers = 0;
    app.llm.on('Antwort', () => (answers++ === 0 ? { title: 5 } : { title: 'korrigiert' }));

    await expect(app.services.llm.completeJson(Answer, request)).resolves.toMatchObject({ title: 'korrigiert' });
    expect(app.llm.textBodies).toHaveLength(2);
    expect((await transmissions()).map((entry) => entry.requests)).toEqual([1, 1]);
  });

  it('keeps the correction note when a long input is cut to a small limit', async () => {
    app.services.settings.update({ llm: { maxInputChars: 500 } });
    let answers = 0;
    app.llm.on('Antwort', () => (answers++ === 0 ? { title: 1, tags: 2, note: 3 } : { title: 'ok' }));

    await app.services.llm.completeJson(Answer, { ...request, input: 'x'.repeat(5000) });

    const second = String(app.llm.textBodies[1]?.input);
    expect(second).toContain('gekürzt');
    expect(second.endsWith('Antworte erneut ausschließlich mit gültigem JSON gemäß Schema.')).toBe(true);
    expect(second).toMatch(/title: .*; tags: /);
  });
});

describe('thinking depth (#154)', () => {
  const effortSent = (index = 0) => (app.llm.textBodies[index]?.reasoning as { effort?: string } | undefined)?.effort;
  const complete = () => app.services.llm.complete({ instructions: 'Test', input: 'Hallo', purpose: 'Struktur' });

  it('sends „none“ as none and leaves the parameter out only for the model default', async () => {
    app.services.settings.update({ llm: { reasoningEffort: 'none' } });
    await complete();
    app.services.settings.update({ llm: { reasoningEffort: null } });
    await complete();

    expect(effortSent(0)).toBe('none');
    expect(app.llm.textBodies[1]).not.toHaveProperty('reasoning');
  });

  it.each(['xhigh', 'max'])('sends %s as chosen to an endpoint that takes it', async (effort) => {
    app.services.settings.update({ llm: { reasoningEffort: effort as 'xhigh' | 'max' } });

    await complete();

    expect(effortSent()).toBe(effort);
  });

  it('steps max down to xhigh and then high when the endpoint rejects them, and remembers the highest it accepts', async () => {
    app.services.settings.update({ llm: { reasoningEffort: 'max' } });
    app.llm.rejectEfforts = ['max', 'xhigh'];

    await complete();
    await complete();

    expect(app.llm.textBodies.map((_body, index) => effortSent(index))).toEqual(['max', 'xhigh', 'high', 'high']);
    const [latest, first] = await transmissions();
    expect(first).toMatchObject({ requests: 3, note: expect.stringContaining('„max“ als „high“') });
    expect(latest).toMatchObject({ requests: 1, note: expect.stringContaining('„max“ als „high“') });
  });

  it('drops the thinking depth only when even high is rejected, and says so', async () => {
    app.services.settings.update({ llm: { reasoningEffort: 'xhigh' } });
    app.llm.rejectEfforts = ['xhigh', 'high'];

    await complete();

    expect(app.llm.textBodies.map((_body, index) => effortSent(index))).toEqual(['xhigh', 'high', undefined]);
    expect((await transmissions())[0]?.note).toContain('Denktiefe');
  });

  it('keeps older settings valid', () => {
    for (const effort of ['none', 'minimal', 'low', 'medium', 'high'] as const)
      expect(app.services.settings.update({ llm: { reasoningEffort: effort } }).llm.reasoningEffort).toBe(effort);
  });
});

describe('output limits (#153)', () => {
  const Topic = z.object({ name: z.string().nullable() });
  const topic = { instructions: 'Test', input: 'Hallo', purpose: 'Struktur', schemaName: 'TopicName' };

  beforeEach(() => {
    app.llm.on('TopicName', () => ({ name: 'Thema' }));
  });

  it('sets no limit while the model may think, as reasoning tokens count against it', async () => {
    for (const effort of [null, 'low', 'high'] as const) {
      app.services.settings.update({ llm: { reasoningEffort: effort } });
      await app.services.llm.completeJson(Topic, topic);
    }

    expect(app.llm.textBodies.every((body) => !('max_output_tokens' in body))).toBe(true);
  });

  it('sets the limit of the schema when thinking is explicitly off', async () => {
    app.services.settings.update({ llm: { reasoningEffort: 'none' } });

    await app.services.llm.completeJson(Topic, topic);

    expect(app.llm.textBodies[0]).toMatchObject({ max_output_tokens: 400 });
  });

  it('records a dropped „none“ and then sends no limit, as the model may think again', async () => {
    app.services.settings.update({ llm: { reasoningEffort: 'none' } });
    app.llm.rejectEfforts = ['none'];

    await app.services.llm.completeJson(Topic, topic);
    await app.services.llm.completeJson(Topic, topic);

    expect(app.llm.textBodies.map((body) => body.max_output_tokens)).toEqual([400, undefined, undefined]);
    expect(app.llm.textBodies.every((body, index) => index === 0 || !('reasoning' in body))).toBe(true);
    const entries = await app.ok('llm:transmissions', { limit: 10 });
    expect(entries[0]?.note).toContain('„none“ weggelassen');
    expect(entries[1]?.note).toContain('„none“ weggelassen');
  });

  it('sets the limit for Claude, which does not think here', async () => {
    app.services.settings.update({ llm: { baseUrl: 'https://llm.example.test/anthropic' } });

    await app.services.llm.completeJson(Topic, topic);

    expect(app.llm.textBodies[0]).toMatchObject({ max_tokens: 400 });
  });

  it('sets none for schemas without a known limit and never overrides a limit of the caller', async () => {
    app.services.settings.update({ llm: { reasoningEffort: 'none' } });
    app.llm.on('Antwort', () => ({ title: 'T' }));

    await app.services.llm.completeJson(Answer, { ...topic, schemaName: 'Antwort' });
    await app.services.llm.completeJson(Topic, { ...topic, maxOutputTokens: 77 });

    expect(app.llm.textBodies[0]).not.toHaveProperty('max_output_tokens');
    expect(app.llm.textBodies[1]).toMatchObject({ max_output_tokens: 77 });
  });
});
