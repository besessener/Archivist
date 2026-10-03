import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ configured: false });
});
afterEach(async () => {
  await app.cleanup();
});

async function archiveAndIndex(id: string): Promise<void> {
  const plan = await app.ok('documents:previewArchive', { items: [{ documentId: id, mode: 'copy' }] });
  await app.ok('documents:archive', {
    items: [{ documentId: id, mode: 'copy' }],
    confirmed: true,
    approveNewCategories: plan.newCategories,
    confirmMove: false,
  });
  await app.services.documents.indexDocument(id);
}

describe('Documents list search (#171)', () => {
  it('also finds a word that only appears in the text of a document', async () => {
    const imported = await app.ok('documents:import', {
      paths: [
        app.file('in/protokoll.txt', 'Besprechung am Montag. Der Zebrastreifen vor der Schule wird verlegt.'),
        app.file('in/rechnung.txt', 'Rechnung für Büromaterial.'),
      ],
    });
    await app.services.jobs.whenIdle();
    for (const { id } of imported.imported) await archiveAndIndex(id);

    const found = await app.ok('documents:list', { query: 'Zebrastreifen' });

    expect(found.map((d) => d.originalName)).toEqual(['protokoll.txt']);
    expect(await app.ok('documents:list', { query: 'Zebrastreifen Schule' })).toHaveLength(1);
    expect(await app.ok('documents:list', { query: 'Zebrastreifen Büromaterial' })).toHaveLength(0);
  });

  it('finds a document whose terms stand in different passages of a long text', async () => {
    const filler = 'Allgemeine Bedingungen gelten unverändert weiter. '.repeat(40);
    const imported = await app.ok('documents:import', {
      paths: [app.file('in/vertrag.txt', `Kündigung des Vertrags zum Jahresende. ${filler}Die Frist endet im Mai.`)],
    });
    await app.services.jobs.whenIdle();
    const id = imported.imported[0]!.id;
    await archiveAndIndex(id);

    expect((await app.ok('documents:list', { query: 'Kündigung Frist' })).map((d) => d.id)).toEqual([id]);
    expect(await app.ok('documents:list', { query: 'Kündigung Zebrastreifen' })).toHaveLength(0);
  });
});
