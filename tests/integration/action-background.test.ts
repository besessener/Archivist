import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { classification } from '../helpers/document-classifications';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.cleanup();
});

async function importDocuments(count: number): Promise<string[]> {
  app.llm.on('DocumentClassification', (_schema, input) =>
    classification({ title: `Dokument ${input.length}`, summary: 'Zusammenfassung', categoryPath: 'Privat/notizen' }),
  );
  const paths = Array.from({ length: count }, (_, i) => app.file(`in/doc-${i}.txt`, `Inhalt des Dokuments Nummer ${i}`));
  const imported = await app.ok('documents:import', { paths });
  await app.services.jobs.whenIdle();
  return imported.imported.map((d) => d.id);
}

const propose = (ids: string[], categoryPath = 'Privat/notizen') =>
  app.services.actions.propose({
    actionType: 'archive_documents',
    label: `${ids.length} Dokumente nach ${categoryPath} archivieren`,
    rationale: 'Test',
    confidence: 0.9,
    affectedEntities: [],
    requiredConfirmation: 'confirm',
    proposedParameters: {
      items: ids.map((documentId) => ({ documentId, mode: 'copy', categoryPath })),
      approveNewCategories: [categoryPath],
    },
  });

const approve = (actionId: string) => app.ok('actions:resolve', { actionId, decision: 'approve', confirmed: true });
const archivedFile = (id: string) => path.join(app.services.settings.get().archiveRoot, ...app.services.documents.getRow(id).archiveRelPath!.split('/'));
const jobOf = (label: string) => app.services.jobs.list().find((job) => job.type === 'action.execute' && job.label === label);

/** Ten archived documents and a relocation of all of them, which runs as a job; `conflicting` edits the files so nothing can move. */
async function bigRelocation({ conflicting }: { conflicting: boolean }) {
  const [target, ...ids] = await importDocuments(11);
  await approve(propose(ids).id);
  await approve(propose([target!], 'Privat/ziel').id);
  if (conflicting) for (const id of ids) fs.appendFileSync(archivedFile(id), ' – bearbeitet');
  return app.services.actions.propose({
    actionType: 'relocate_documents',
    label: `${ids.length} Dokumente verschieben`,
    rationale: 'Test',
    confidence: 0.8,
    affectedEntities: [],
    requiredConfirmation: 'confirm',
    proposedParameters: { items: ids.map((documentId) => ({ documentId, categoryPath: 'Privat/ziel' })) },
  });
}

/** The confirming caller stops waiting before the job ran: the queue is paused while it confirms, then the job runs. */
async function confirmBeforeJobRuns<T>(confirm: () => Promise<T>): Promise<T> {
  await app.services.jobs.stop();
  vi.spyOn(app.services.jobs, 'waitFor').mockImplementation(async (id) => app.services.jobs.get(id));
  const answer = await confirm();
  app.services.jobs.start();
  await app.services.jobs.whenIdle();
  return answer;
}

describe('Big confirmed actions run as a job (#254)', () => {
  it('archives many documents in a job and still returns the result', async () => {
    const action = propose(await importDocuments(12));

    const resolved = await approve(action.id);

    expect(resolved.status).toBe('executed');
    expect(resolved.result).toMatch(/12 archiviert/);
    expect(jobOf(action.label)).toMatchObject({ status: 'succeeded' });
  });

  it('keeps small actions inline', async () => {
    const action = propose(await importDocuments(2));

    const resolved = await approve(action.id);

    expect(resolved.status).toBe('executed');
    expect(app.services.jobs.list().some((job) => job.type === 'action.execute')).toBe(false);
  });

  it('leaves a proposal that was never confirmed untouched when a job reports no result', async () => {
    const action = propose(await importDocuments(1));
    app.services.actions.markNotExecuted(action.id, 'egal');
    expect(app.services.actions.get(action.id).status).toBe('proposed');
  });

  it('fails the job when the action failed, also when the job is retried', async () => {
    const action = await bigRelocation({ conflicting: true });

    const resolved = await approve(action.id);

    expect(resolved.status).toBe('failed');
    const job = jobOf(action.label)!;
    expect(job).toMatchObject({ status: 'failed', error: expect.stringMatching(/nichts verschoben/) });
    app.services.jobs.retry(job.id);
    await app.services.jobs.whenIdle();
    expect(app.services.jobs.get(job.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/nichts verschoben/) });
  });
});

describe('Accepting an insight whose action runs as a job (#254)', () => {
  const insightFor = (actionId: string) =>
    app.services.insights.upsert({
      kind: 'scattered_documents',
      title: 'Dokumente liegen verstreut',
      explanation: 'Test',
      confidence: 0.8,
      recommendedActionId: actionId,
      dedupeKey: `test:${actionId}`,
    });

  it('stays open while the job runs and when it fails', async () => {
    const insight = insightFor((await bigRelocation({ conflicting: true })).id);

    const answered = await confirmBeforeJobRuns(() => app.services.insights.accept(insight.id, {}));

    expect(answered.status).toBe('open');
    expect(app.services.actions.get(insight.recommendedActionId!).status).toBe('failed');
    expect(app.services.insights.get(insight.id).status).toBe('open');
  });

  it('is accepted once the job executed the action', async () => {
    const insight = insightFor((await bigRelocation({ conflicting: false })).id);

    const answered = await confirmBeforeJobRuns(() => app.services.insights.accept(insight.id, {}));

    expect(answered.status).toBe('open');
    expect(app.services.actions.get(insight.recommendedActionId!).status).toBe('executed');
    expect(app.services.insights.get(insight.id).status).toBe('accepted');
  });
});
