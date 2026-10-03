import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { classification } from '../helpers/document-classifications';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
  app.llm.on('DocumentClassification', () => classification({ title: 'Mietvertrag', summary: 'Mietvertrag Hauptstraße', categoryPath: 'private/wohnen' }));
  app.llm.embed = (texts) => texts.map(() => [1, 0, 0]);
});
afterEach(async () => {
  await app.cleanup();
});

async function archivedDocument(): Promise<string> {
  const imported = await app.ok('documents:import', { paths: [app.file('in/mietvertrag.txt', 'Mietvertrag für die Wohnung in der Hauptstraße.')] });
  await app.services.jobs.whenIdle();
  const id = imported.imported[0]!.id;
  const plan = await app.ok('documents:previewArchive', { items: [{ documentId: id, mode: 'copy' }] });
  await app.ok('documents:archive', {
    items: [{ documentId: id, mode: 'copy' }],
    confirmed: true,
    approveNewCategories: plan.newCategories,
    confirmMove: false,
  });
  await app.services.documents.indexDocument(id);
  return id;
}

describe('Re-embedding after the embedding model changed (#173)', () => {
  it('moves existing documents to the new model in a job', async () => {
    const id = await archivedDocument();
    expect(app.services.search.entriesWithOtherModel('model-a').map((e) => e.id)).toContain(id);

    await app.ok('settings:update', { llm: { embeddingModel: 'model-a' } });
    await app.services.jobs.whenIdle();

    expect(app.services.search.entriesWithOtherModel('model-a').map((e) => e.id)).not.toContain(id);
    expect(app.services.jobs.list().find((job) => job.type === 'search.reembed')).toMatchObject({ status: 'succeeded' });

    await app.ok('settings:update', { llm: { embeddingModel: 'model-b' } });
    await app.services.jobs.whenIdle();

    expect(app.services.search.entriesWithOtherModel('model-b').map((e) => e.id)).not.toContain(id);
    expect(app.services.search.entriesWithOtherModel('model-a').map((e) => e.id)).toContain(id);
  });

  it('does not start a job for other settings changes', async () => {
    await app.ok('settings:update', { llm: { timeoutMs: 45_000 } });
    await app.services.jobs.whenIdle();
    expect(app.services.jobs.list().some((job) => job.type === 'search.reembed')).toBe(false);
  });
});
