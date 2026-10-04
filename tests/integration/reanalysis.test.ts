import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archived } from '../helpers/agent';
import { classification } from '../helpers/document-classifications';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
let id: string;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'confirm' });
  id = await archived(app, {
    name: 'schreiben.txt',
    content: 'Schreiben der Hausverwaltung zur Nebenkostenabrechnung 2025 für die Wohnung in der Musterstraße 1.',
    folder: 'Privat/wohnen',
    topic: 'Wohnen',
  });
  app.llm.on('DocumentClassification', () =>
    classification({
      title: 'Nebenkostenabrechnung 2025',
      summary: 'Die Hausverwaltung rechnet die Nebenkosten ab.',
      categoryPath: 'Privat/steuern',
      docType: 'Abrechnung',
      mainTopic: 'Nebenkosten',
      persons: ['Maria Beispiel'],
      tags: ['abrechnung'],
      documentDate: '2026-02-01',
    }),
  );
});
afterEach(async () => {
  await app.cleanup();
});

const reprocess = async (options: { reread?: boolean; reanalyze?: boolean; confirmLlm?: boolean } = {}) => {
  const { jobId } = await app.ok('documents:reprocess', { ids: [id], reread: false, reanalyze: true, confirmLlm: true, ...options });
  await app.services.jobs.whenIdle();
  return app.services.jobs.get(jobId);
};
const lastAudit = async (action: string) => (await app.ok('audit:list', {})).find((entry) => entry.action === action)!;

describe('Metadata-only re-analysis of archived documents (#220)', () => {
  it('only proposes: metadata, file and location stay as they are', async () => {
    const before = await app.ok('documents:get', { id });
    const fileBefore = fs.readFileSync(before.archivePath!);

    const job = await reprocess();

    expect(job.status).toBe('succeeded');
    const proposal = await app.ok('documents:reanalysis', { id });
    expect(proposal).toMatchObject({
      title: 'Nebenkostenabrechnung 2025',
      docType: 'Abrechnung',
      topic: 'Nebenkosten',
      analyzedBy: 'llm',
      documentDate: '2026-02-01',
    });
    const after = await app.ok('documents:get', { id });
    expect(after).toMatchObject({
      title: before.title,
      archiveRelPath: before.archiveRelPath,
      categoryPath: before.categoryPath,
      topicName: 'Wohnen',
      status: 'archived',
    });
    expect(fs.readFileSync(after.archivePath!)).toEqual(fileBefore);
    expect(await app.ok('documents:reanalysisPending', {})).toEqual({ documentIds: [id] });
  });

  it('sends the stored text to the LLM only with the consent in „vorher fragen“', async () => {
    await reprocess({ confirmLlm: false });

    expect(app.llm.calls.filter((call) => call.schema === 'DocumentClassification' && call.input.includes('Nebenkostenabrechnung 2025 für'))).toHaveLength(0);
    expect((await app.ok('documents:reanalysis', { id }))!.analyzedBy).toBe('local');
  });

  it('applies the proposal only after the confirmation, as an undoable level-2 change', async () => {
    const before = await app.ok('documents:get', { id });
    await reprocess();

    const refused = await app.call('documents:applyReanalysis', { id, confirmed: false } as never);
    expect(refused.ok).toBe(false);
    expect((await app.ok('documents:get', { id })).title).not.toBe('Nebenkostenabrechnung 2025');

    const applied = await app.ok('documents:applyReanalysis', { id, confirmed: true });

    expect(applied).toMatchObject({
      title: 'Nebenkostenabrechnung 2025',
      docType: 'Abrechnung',
      summary: 'Die Hausverwaltung rechnet die Nebenkosten ab.',
      documentDate: '2026-02-01',
    });
    expect(applied.tags).toContain('abrechnung');
    expect(applied.persons).toContain('Maria Beispiel');
    expect(applied.topicName).toBe('Nebenkosten');
    expect(applied.archiveRelPath).toBe((await app.ok('documents:get', { id })).archiveRelPath);
    expect(applied.categoryPath).toBe('Privat/wohnen');
    expect(await app.ok('documents:reanalysis', { id })).toBeNull();
    const entry = await lastAudit('document.applyReanalysis');
    expect(entry).toMatchObject({ confirmed: true, actor: 'user' });

    expect((await app.ok('audit:undo', { auditId: entry.id })).undone).toBe(true);
    const restored = await app.ok('documents:get', { id });
    expect(restored).toMatchObject({
      title: before.title,
      topicName: before.topicName,
      docType: before.docType,
      summary: before.summary,
      documentDate: before.documentDate,
    });
    expect(restored.tags).toEqual(before.tags);
    expect(restored.persons).toEqual(before.persons);
  });

  it('never clears an existing topic when the proposal names none', async () => {
    app.llm.on('DocumentClassification', () => classification({ title: 'Anderer Titel', summary: 'x', categoryPath: 'Privat/wohnen', mainTopic: null }));
    await reprocess();

    const applied = await app.ok('documents:applyReanalysis', { id, confirmed: true });

    expect(applied).toMatchObject({ title: 'Anderer Titel', topicName: 'Wohnen' });
  });

  it('can be discarded without any change', async () => {
    await reprocess();

    await app.ok('documents:discardReanalysis', { id });

    expect(await app.ok('documents:reanalysis', { id })).toBeNull();
    expect(await app.ok('documents:get', { id })).toMatchObject({ title: 'schreiben' });
    expect((await app.call('documents:applyReanalysis', { id, confirmed: true })).ok).toBe(false);
  });

  it('reads the file again first when asked, then proposes from the new text', async () => {
    const { archivePath } = await app.ok('documents:get', { id });
    fs.writeFileSync(archivePath!, 'Völlig neuer Inhalt der Datei, jetzt über einen Mietvertrag.');

    await reprocess({ reread: true });

    expect((await app.ok('documents:get', { id })).textPreview).toContain('Mietvertrag');
    expect(app.llm.calls.at(-1)!.input).toContain('Mietvertrag');
  });

  it('waits and tries again when the endpoint rate-limits, keeping the proposal pending until it succeeds', async () => {
    app.llm.failing = { count: 6, status: 429, retryAfter: '0' };

    const job = await reprocess();

    expect(app.llm.failing.count).toBe(0);
    expect(job.status).toBe('succeeded');
    expect((await app.ok('documents:reanalysis', { id }))!.analyzedBy).toBe('llm');
  });

  it('summarises a run in one notification and counts documents it could not process', async () => {
    const other = await archived(app, { name: 'zweites.txt', content: 'Zweites Dokument mit ausreichend Text für eine Neuanalyse.', folder: 'Privat/wohnen' });
    app.llm.status = 400;
    app.services.database.sqlite.prepare("UPDATE documents SET extracted_text = '' WHERE id = ?").run(other);

    const { jobId } = await app.ok('documents:reprocess', { ids: [id, other], reread: false, reanalyze: true, confirmLlm: true });
    await app.services.jobs.whenIdle();

    expect(app.services.jobs.get(jobId).summary).toBe('1 Dokument neu verarbeitet, 1 Fehler');
    const notices = app.services.notifications.list().filter((n) => n.title === 'Neuverarbeitung abgeschlossen');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.description).toContain('1 Vorschläge');
  });

  it('refuses documents that are not archived', async () => {
    const inbox = (await app.ok('documents:import', { paths: [app.file('in/neu.txt', 'Neu im Eingang mit Text.')] })).imported[0]!.id;

    const result = await app.call('documents:reprocess', { ids: [inbox], reread: false, reanalyze: true, confirmLlm: false });

    expect(result.ok).toBe(false);
  });

  it('estimates what a run would send', async () => {
    const estimate = await app.ok('documents:reprocessEstimate', { ids: [id] });

    expect(estimate).toMatchObject({ total: 1, llmEligible: 1 });
    expect(estimate.estimatedTokens).toBeGreaterThan(400);
  });

  it('estimates every part of a long text', async () => {
    const short = (await app.ok('documents:reprocessEstimate', { ids: [id] })).estimatedTokens;
    app.services.database.sqlite.prepare('UPDATE documents SET extracted_text = ? WHERE id = ?').run('Wort '.repeat(40_000), id);

    const long = (await app.ok('documents:reprocessEstimate', { ids: [id] })).estimatedTokens;

    expect(long).toBeGreaterThan(2 * short);
  });

  describe('honours the privacy rules', () => {
    const analysisCalls = () =>
      app.llm.calls.filter((call) => call.schema === 'DocumentClassification' && call.input.includes('Nebenkostenabrechnung 2025 für'));

    it.each([
      ['a document excluded from the LLM', async () => void (await app.ok('documents:setLlmExcluded', { id, excluded: true }))],
      ['a file type on the never-analyse list', async () => void app.services.settings.update({ privacy: { neverAnalyzeExtensions: ['txt'] } })],
      ['local-only mode', async () => void app.services.settings.update({ privacy: { llmMode: 'local_only' } })],
    ])('sends nothing and logs no transmission for %s', async (_name, restrict) => {
      await restrict();
      const transmissions = (await app.ok('llm:transmissions', { limit: 100 })).length;

      const estimate = await app.ok('documents:reprocessEstimate', { ids: [id] });
      await reprocess();

      expect(estimate.llmEligible).toBe(0);
      expect(analysisCalls()).toHaveLength(0);
      expect((await app.ok('llm:transmissions', { limit: 100 })).length).toBe(transmissions);
      expect((await app.ok('documents:reanalysis', { id }))!.analyzedBy).toBe('local');
    });

    it('records the permitted analysis in the transmission log', async () => {
      await reprocess();

      expect(analysisCalls()).toHaveLength(1);
      expect((await app.ok('llm:transmissions', { limit: 100 })).some((entry) => entry.documentIds.includes(id))).toBe(true);
    });
  });
});
