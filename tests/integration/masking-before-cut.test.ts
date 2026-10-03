import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classification } from '../helpers/document-classifications';
import { createTestApp, type TestApp } from '../helpers/harness';

const IBAN = 'DE89 3704 0044 0532 0130 00';
const IBAN_GROUPS = ['3704', '0044', '0532', '0130'];

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const leaks = (text: string) => IBAN_GROUPS.filter((group) => text.includes(group));
/** Padding of `length` characters, then the IBAN, then more text. */
const withIbanAt = (length: number, total = length + 600) => `${'x'.repeat(length)} ${IBAN} ${'y'.repeat(total - length - IBAN.length)}`;

describe('text is masked before it is cut', () => {
  it('masks an identifier at the cut of an over-long LLM input', async () => {
    app.services.settings.update({ llm: { maxInputChars: 500 } });
    app.llm.on('plain', () => 'OK');

    // the head keeps 375 of 500 characters: the IBAN starts a few characters before that
    await app.services.llm.complete({ instructions: 'Test', input: withIbanAt(365, 1200), purpose: 'Test' });

    const sent = JSON.stringify(app.llm.textBodies.at(-1)!.input);
    expect(sent).toContain('gekürzt');
    expect(leaks(sent)).toEqual([]);
  });

  it('masks an identifier at the 8000-character cut of an embedding text', async () => {
    app.services.settings.update({ llm: { embeddingModel: 'test-embedding' } });
    app.llm.embed = (texts) => texts.map(() => [1, 0, 0]);

    await app.services.llm.embeddings([withIbanAt(7990, 8200)], { purpose: 'Test' });

    const sent = app.llm.embeddingRequests.flat().join(' ');
    expect(sent.length).toBeLessThanOrEqual(8000);
    expect(leaks(sent)).toEqual([]);
  });

  it('masks an identifier at the cut of the preview in the transmission log', async () => {
    app.llm.on('DocumentClassification', () => classification({ title: 'Brief', summary: 'x', categoryPath: 'private/post' }));

    await app.ok('documents:import', { paths: [app.file('in/brief.txt', withIbanAt(150, 700))] });
    await app.services.jobs.whenIdle();

    const entries = (await app.ok('llm:transmissions', { limit: 50 })).filter((entry) => entry.purpose.startsWith('Dokumentklassifikation'));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(leaks(entry.preview)).toEqual([]);
  });

  it('masks identifiers that sit on the border between two parts of a long document', async () => {
    app.services.settings.update({ llm: { maxInputChars: 2000 } });
    app.llm.on('DocumentClassification', () => classification({ title: 'Brief', summary: 'x', categoryPath: 'private/post' }));
    const text = `${IBAN} ${'a'.repeat(60)} `.repeat(100);

    await app.ok('documents:import', { paths: [app.file('in/lang.txt', text)] });
    await app.services.jobs.whenIdle();

    const calls = app.llm.calls.filter((call) => call.schema === 'DocumentClassification');
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) expect(leaks(call.input)).toEqual([]);
  });
});
