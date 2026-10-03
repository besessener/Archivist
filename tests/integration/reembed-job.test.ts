import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { classification } from '../helpers/document-classifications';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
  app.llm.on('DocumentClassification', () => classification({ title: 'Mietvertrag', summary: 'Mietvertrag Hauptstraße', categoryPath: 'Privat/wohnen' }));
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

/** Ids the re-embedding job would move onto `model`, with the document rule the job uses. */
const staleIds = (model: string) =>
  app.services.search.entriesWithOtherModel(model, (id) => app.services.documents.embedsRemotely(id)).map((entry) => entry.id);
const reembedJobs = () => app.services.jobs.list().filter((job) => job.type === 'search.reembed');

describe('Re-embedding after the embedding model changed (#173)', () => {
  it('moves existing documents to the new model in a job', async () => {
    const id = await archivedDocument();
    expect(staleIds('model-a')).toContain(id);

    await app.ok('settings:update', { llm: { embeddingModel: 'model-a' } });
    await app.services.jobs.whenIdle();

    expect(staleIds('model-a')).not.toContain(id);
    expect(reembedJobs()[0]).toMatchObject({ status: 'succeeded', summary: '1 Eintrag neu eingebettet' });

    await app.ok('settings:update', { llm: { embeddingModel: 'model-b' } });
    await app.services.jobs.whenIdle();

    expect(staleIds('model-b')).not.toContain(id);
    expect(staleIds('model-a')).toContain(id);
  });

  it('queues another job when the model changes again while a job is running', async () => {
    const id = await archivedDocument();
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    app.llm.embed = async (texts) => {
      await gate;
      return texts.map(() => [1, 0, 0]);
    };
    await app.ok('settings:update', { llm: { embeddingModel: 'model-a' } });
    while (app.llm.embeddingRequests.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));

    await app.ok('settings:update', { llm: { embeddingModel: 'model-b' } });
    release();
    await app.services.jobs.whenIdle();

    expect(reembedJobs()).toHaveLength(2);
    expect(staleIds('model-b')).not.toContain(id);
  });

  it('fails retryably with the real count while the endpoint is down, and moves the entries once it is back', async () => {
    const id = await archivedDocument();
    app.llm.down = true;
    await app.ok('settings:update', { llm: { embeddingModel: 'model-a' } });
    await app.services.jobs.whenIdle();

    const [failed] = reembedJobs();
    expect(failed).toMatchObject({ status: 'failed', attempts: 3 });
    expect(failed?.error).toContain('Nur 0 von 1 Einträgen neu eingebettet');
    expect(staleIds('model-a')).toContain(id);

    app.llm.down = false;
    app.services.jobs.retry(failed!.id);
    await app.services.jobs.whenIdle();

    expect(reembedJobs()[0]).toMatchObject({ status: 'succeeded', summary: '1 Eintrag neu eingebettet' });
    expect(staleIds('model-a')).not.toContain(id);
  });

  it('does not re-index a document excluded from external analysis', async () => {
    const id = await archivedDocument();
    app.services.documents.setLlmExcluded(id, { excluded: true });
    await app.services.jobs.whenIdle();

    await app.ok('settings:update', { llm: { embeddingModel: 'model-a' } });
    await app.services.jobs.whenIdle();

    expect(reembedJobs()[0]).toMatchObject({ status: 'succeeded', summary: '0 Einträge neu eingebettet' });
  });

  it('does not re-index local documents in the mode „vorher fragen“', async () => {
    await archivedDocument();
    await app.ok('settings:update', { privacy: { llmMode: 'confirm' } });

    await app.ok('settings:update', { llm: { embeddingModel: 'model-a' } });
    await app.services.jobs.whenIdle();

    expect(reembedJobs()[0]).toMatchObject({ status: 'succeeded', summary: '0 Einträge neu eingebettet' });
    expect(app.llm.embeddingRequests).toEqual([]);
  });

  it('does not start a job for other settings changes', async () => {
    await app.ok('settings:update', { llm: { timeoutMs: 45_000 } });
    await app.services.jobs.whenIdle();
    expect(app.services.jobs.list().some((job) => job.type === 'search.reembed')).toBe(false);
  });
});
