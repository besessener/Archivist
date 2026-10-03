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

async function importDocuments(count: number): Promise<string[]> {
  app.llm.on('DocumentClassification', (_schema, input) =>
    classification({ title: `Dokument ${input.length}`, summary: 'Zusammenfassung', categoryPath: 'private/notizen' }),
  );
  const paths = Array.from({ length: count }, (_, i) => app.file(`in/doc-${i}.txt`, `Inhalt des Dokuments Nummer ${i}`));
  const imported = await app.ok('documents:import', { paths });
  await app.services.jobs.whenIdle();
  return imported.imported.map((d) => d.id);
}

const propose = (ids: string[]) =>
  app.services.actions.propose({
    actionType: 'archive_documents',
    label: `${ids.length} Dokumente archivieren`,
    rationale: 'Test',
    confidence: 0.9,
    affectedEntities: [],
    requiredConfirmation: 'confirm',
    proposedParameters: {
      items: ids.map((documentId) => ({ documentId, mode: 'copy', categoryPath: 'private/notizen' })),
      approveNewCategories: ['private/notizen'],
    },
  });

describe('Big confirmed actions run as a job (#254)', () => {
  it('archives many documents in a job and still returns the result', async () => {
    const action = propose(await importDocuments(12));

    const resolved = await app.ok('actions:resolve', { actionId: action.id, decision: 'approve', confirmed: true });

    expect(resolved.status).toBe('executed');
    expect(resolved.result).toMatch(/12 archiviert/);
    expect(app.services.jobs.list().find((job) => job.type === 'action.execute')).toMatchObject({ status: 'succeeded' });
  });

  it('keeps small actions inline', async () => {
    const action = propose(await importDocuments(2));

    const resolved = await app.ok('actions:resolve', { actionId: action.id, decision: 'approve', confirmed: true });

    expect(resolved.status).toBe('executed');
    expect(app.services.jobs.list().some((job) => job.type === 'action.execute')).toBe(false);
  });

  it('leaves a proposal that was never confirmed untouched when a job reports no result', async () => {
    const action = propose(await importDocuments(1));
    app.services.actions.markNotExecuted(action.id, 'egal');
    expect(app.services.actions.get(action.id).status).toBe('proposed');
  });
});
