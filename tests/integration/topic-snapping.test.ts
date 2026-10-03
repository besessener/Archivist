import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { classification } from '../helpers/document-classifications';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const addTopics = (names: string[]) => names.forEach((name) => app.services.graph.ensureEntity({ type: 'topic', name }));

/** 600 filler topics that sort before „Zwiebelzucht“, so the one that matters is far beyond the first 500 and the first 40. */
const fillerTopics = () => Array.from({ length: 600 }, (_, i) => `Aktenthema ${String(i).padStart(4, '0')}`);

async function analyze(text: string, llmTopic: string | null) {
  app.llm.on('DocumentClassification', () => classification({ title: 'Notiz', summary: 'x', categoryPath: 'private/garten', mainTopic: llmTopic }));
  const imported = await app.ok('documents:import', { paths: [app.file('in/notiz.txt', text)] });
  await app.services.jobs.whenIdle();
  return app.ok('documents:get', { id: imported.imported[0]!.id });
}

describe('Topic lookup beyond the first 500 topics (#195)', () => {
  it('snaps the LLM topic to an existing topic that sorts after 500 others instead of creating a duplicate', async () => {
    addTopics([...fillerTopics(), 'Zwiebelzucht']);

    const doc = await analyze('Notizen zur Zwiebelzucht im Garten, viel Text darüber.', 'zwiebelzucht');

    expect(doc.proposal?.topic).toBe('Zwiebelzucht');
  });

  it('names the topics that fit the document in the prompt, not just the first 40', async () => {
    addTopics([...fillerTopics(), 'Zwiebelzucht']);

    await analyze('Notizen zur Zwiebelzucht im Garten.', null);

    const prompt = app.llm.calls.find((call) => call.schema === 'DocumentClassification')!.input;
    expect(prompt).toContain('Zwiebelzucht');
  });

  it('finds a known topic locally in the text even when it sorts after 500 others', async () => {
    addTopics([...fillerTopics(), 'Zwiebelzucht']);
    app.services.settings.update({ privacy: { llmMode: 'local_only' } });

    const doc = await analyze('Notizen zur Zwiebelzucht im Garten.', null);

    expect(doc.proposal?.analyzedBy).toBe('local');
    expect(doc.proposal?.topic).toBe('Zwiebelzucht');
  });

  it('does not merge topics that differ in a year or a place', async () => {
    addTopics(['Steuer 2021', 'Mietvertrag Berlin', 'Kfz-Versicherung 2023']);

    expect((await analyze('Steuerunterlagen.', 'Steuer 2022')).proposal?.topic).toBe('Steuer 2022');
    expect((await analyze('Mietvertrag in der Stadt, anderer Text.', 'Mietvertrag Bern')).proposal?.topic).toBe('Mietvertrag Bern');
    expect((await analyze('Police der Autoversicherung, noch anderer Text.', 'Kfz-Versicherung 2024')).proposal?.topic).toBe('Kfz-Versicherung 2024');
  });
});
