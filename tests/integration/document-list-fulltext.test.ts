import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ configured: false });
});
afterEach(async () => {
  await app.cleanup();
});

describe('Documents list search (#171)', () => {
  it('also finds a word that only appears in the text of a document', async () => {
    const imported = await app.ok('documents:import', {
      paths: [
        app.file('in/protokoll.txt', 'Besprechung am Montag. Der Zebrastreifen vor der Schule wird verlegt.'),
        app.file('in/rechnung.txt', 'Rechnung für Büromaterial.'),
      ],
    });
    await app.services.jobs.whenIdle();
    for (const { id } of imported.imported) {
      const plan = await app.ok('documents:previewArchive', { items: [{ documentId: id, mode: 'copy' }] });
      await app.ok('documents:archive', {
        items: [{ documentId: id, mode: 'copy' }],
        confirmed: true,
        approveNewCategories: plan.newCategories,
        confirmMove: false,
      });
      await app.services.documents.indexDocument(id);
    }

    const found = await app.ok('documents:list', { query: 'Zebrastreifen' });

    expect(found.map((d) => d.originalName)).toEqual(['protokoll.txt']);
    expect(await app.ok('documents:list', { query: 'Zebrastreifen Schule' })).toHaveLength(1);
    expect(await app.ok('documents:list', { query: 'Zebrastreifen Büromaterial' })).toHaveLength(0);
  });
});
