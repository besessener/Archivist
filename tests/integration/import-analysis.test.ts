import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { estimateAnalysisTokens } from '../../packages/core/src/services/bulk-estimate';
import { classification } from '../helpers/document-classifications';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'confirm' });
  app.llm.on('DocumentClassification', () => classification({ title: 'Notiz', summary: 'Eine Notiz.', categoryPath: 'private/notizen' }));
});
afterEach(async () => app.cleanup());

const classifications = () => app.llm.calls.filter((call) => call.schema === 'DocumentClassification');
const batchJobs = () => app.services.jobs.list().filter((job) => job.type === 'documents.analyzeBatch');

async function importedLocally(count: number): Promise<string> {
  for (let n = 1; n <= count; n += 1) app.file(`Akten/akte${n}.txt`, `Akte ${n} mit ausreichend Text für die Analyse, einzigartig ${n * 7919}.`);
  await app.ok('documents:import', { paths: [path.join(app.home, 'Akten')] });
  await app.services.jobs.whenIdle();
  return batchJobs()[0]!.id;
}

describe('„Alle N mit KI analysieren“ after a local import (#228)', () => {
  it('estimates with the same formula as the scan and reprocess dialogs', async () => {
    const importJob = await importedLocally(3);
    const lengths = (await app.ok('documents:list', {})).map((document) => app.services.documents.getRow(document.id).extractedText.length);

    const estimate = await app.ok('documents:analyzeImportEstimate', { jobId: importJob });

    expect(estimate).toEqual({ total: 3, llmEligible: 3, estimatedTokens: estimateAnalysisTokens(lengths, app.services.settings.get().llm.maxInputChars) });
  });

  it('needs the consent in the service as well, not only in the schema', async () => {
    const importJob = await importedLocally(1);

    expect(() => app.services.importAnalysis.enqueue({ jobId: importJob, confirmLlm: false })).toThrow(/Zustimmung/);
    expect(await app.call('documents:analyzeImport', { jobId: importJob, confirmLlm: false } as never)).toMatchObject({ ok: false });
    expect(batchJobs()).toHaveLength(1);
  });

  it('queues one run per import however often it is confirmed and analyses each document once', async () => {
    const importJob = await importedLocally(3);
    await app.services.jobs.stop();

    const first = await app.ok('documents:analyzeImport', { jobId: importJob, confirmLlm: true });
    const second = await app.ok('documents:analyzeImport', { jobId: importJob, confirmLlm: true });
    app.services.jobs.start();
    await app.services.jobs.whenIdle();

    expect(second.jobId).toBe(first.jobId);
    expect(classifications()).toHaveLength(3);
  });

  it('offers only documents the LLM has not analysed yet', async () => {
    const importJob = await importedLocally(2);
    await app.ok('documents:analyzeImport', { jobId: importJob, confirmLlm: true });
    await app.services.jobs.whenIdle();

    expect(await app.ok('documents:analyzeImportEstimate', { jobId: importJob })).toMatchObject({ total: 0, llmEligible: 0 });
    expect(await app.call('documents:analyzeImport', { jobId: importJob, confirmLlm: true })).toMatchObject({ ok: false });
    expect(classifications()).toHaveLength(2);
  });
});
