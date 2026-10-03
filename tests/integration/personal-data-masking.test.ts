import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classification } from '../helpers/document-classifications';
import { createTestApp, type TestApp } from '../helpers/harness';

const IBAN = 'DE89 3704 0044 0532 0130 00';
const TEXT = `Bitte überweise an ${IBAN}. Zugang: password=Geheim99xyz. Kartennummer 4111 1111 1111 1111.`;

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
  app.services.settings.update({ llm: { embeddingModel: 'test-embedding' } });
});
afterEach(async () => {
  await app.cleanup();
});

async function analyze(): Promise<void> {
  app.llm.on('DocumentClassification', () => classification({ title: 'Rechnung', summary: 'x', categoryPath: 'private/haus' }));
  await app.ok('documents:import', { paths: [app.file('in/rechnung.txt', TEXT)] });
  await app.services.jobs.whenIdle();
}
const sentInput = () =>
  app.llm.calls
    .filter((call) => call.schema === 'DocumentClassification')
    .map((call) => call.input)
    .join('\n');

describe('masking personal data (#203)', () => {
  it('replaces IBAN and card number by placeholders before the text leaves the machine and counts them apart from secrets', async () => {
    await analyze();

    const sent = sentInput();
    expect(sent).not.toContain('3704');
    expect(sent).not.toContain('4111');
    expect(sent).toContain('[IBAN]');
    expect(sent).toContain('[KARTENNUMMER]');
    expect(sent).not.toContain('Geheim99xyz');
    const [entry] = await app.ok('llm:transmissions', {});
    expect(entry).toMatchObject({ redactions: 3, personalRedactions: 2 });
  });

  it('sends personal data unchanged when the setting is off, but still masks secrets', async () => {
    app.services.settings.update({ privacy: { maskPersonalData: false } });

    await analyze();

    const sent = sentInput();
    expect(sent).toContain(IBAN);
    expect(sent).toContain('4111 1111 1111 1111');
    expect(sent).not.toContain('Geheim99xyz');
    expect((await app.ok('llm:transmissions', {}))[0]).toMatchObject({ redactions: 1, personalRedactions: 0 });
  });

  it('masks embeddings and the log preview in the same way', async () => {
    app.llm.embed = (texts) => texts.map(() => [1, 0, 0]);

    await app.services.llm.embeddings([TEXT], { purpose: 'Test' });

    expect(app.llm.embeddingRequests.flat().join(' ')).not.toContain('3704');
    const entry = (await app.ok('llm:transmissions', {})).find((transmission) => transmission.purpose === 'Test');
    expect(entry?.preview).toContain('[IBAN]');
    expect(entry).toMatchObject({ personalRedactions: 2 });
  });

  it('masks the application log by the same setting', () => {
    const { logger } = app.services;

    expect(logger.sanitizeString(`Konto ${IBAN}`)).toBe('Konto [IBAN]');
    app.services.settings.update({ privacy: { maskPersonalData: false } });
    expect(logger.sanitizeString(`Konto ${IBAN}`)).toBe(`Konto ${IBAN}`);
  });
});
