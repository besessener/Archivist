import fs from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { documents, llmTransmissions } from '../../packages/core/src/db/schema';
import { newId, nowIso } from '../../packages/core/src/util/ids';
import { DecisionInput } from '@archivist/shared';
import { agentApp, archived } from '../helpers/agent';
import { classification } from '../helpers/document-classifications';
import type { TestApp } from '../helpers/harness';

const MARKER = 'zebrakraut4711geheimtext';

let app: TestApp;
beforeEach(async () => {
  app = await agentApp();
});
afterEach(async () => {
  await app.cleanup();
});

/** Every byte SQLite keeps for the archive: database file and write-ahead log, lowercased (the search index stores lowercase tokens). */
const storedBytes = () =>
  [app.services.database.file, `${app.services.database.file}-wal`]
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.readFileSync(file).toString('latin1').toLowerCase())
    .join('\n');
/** An archived document whose text also sits in its summary, its proposal and the preview of a logged transmission. */
async function archivedWithTraces(name: string, text: string): Promise<string> {
  const id = await archived(app, { name, content: text, folder: 'Privat/post' });
  const { db } = app.services.database;
  db.update(documents)
    .set({ summary: `Zusammenfassung: ${text}`, proposal: { reason: text } })
    .where(eq(documents.id, id))
    .run();
  db.insert(llmTransmissions)
    .values({ id: newId(), at: nowIso(), purpose: 'Test', model: 'm', endpoint: 'e', bytes: 1, documentIds: [id], preview: text })
    .run();
  return id;
}
/** A text spanning several database pages, so deleting it frees some. */
const longText = (lead: string) => `${lead} ${'Weiterer Inhalt des Schreibens, Seite für Seite. '.repeat(400)}`;
const freePages = () => app.services.database.sqlite.pragma('freelist_count', { simple: true }) as number;
const tableText = (table: string) => JSON.stringify(app.services.database.sqlite.prepare(`SELECT * FROM ${table}`).all()).toLowerCase();

describe('emptying the trash removes the extracted text from Archivist', () => {
  it('leaves no text in the documents, undo data, transmission previews, search index or database file', async () => {
    const id = await archivedWithTraces('Geheim.txt', `Vertraulich: ${MARKER} steht nur hier.`);
    expect(tableText('llm_transmissions'), 'precondition: a preview holds the text').toContain(MARKER);
    await app.ok('documents:trash', { id, confirmed: true });
    expect(tableText('audit_log'), 'while in the trash the text is kept for the undo').toContain(MARKER);

    const result = await app.ok('trash:empty', { confirmed: true, permanentlyConfirmed: true });

    expect(result).toMatchObject({ documents: 1, databaseCompacted: true });
    for (const table of ['documents', 'audit_log', 'llm_transmissions', 'chunks', 'search_fts', 'entities'])
      expect(tableText(table), table).not.toContain(MARKER);
    expect(storedBytes()).not.toContain(MARKER);
  });

  it('keeps the transmission entries and the derived records, only the previews are emptied', async () => {
    const id = await archivedWithTraces('Mehr.txt', `Beschluss: ${MARKER}`);
    const decision = app.services.decisions.create(
      DecisionInput.parse({ title: 'Wir nehmen Angebot B', decisionText: 'Angebot B wird genommen.', sourceIds: [id] }),
    );
    const before = await app.ok('llm:transmissions', { limit: 100 });
    await app.ok('documents:trash', { id, confirmed: true });

    await app.ok('trash:empty', { confirmed: true, permanentlyConfirmed: true });

    const after = await app.ok('llm:transmissions', { limit: 100 });
    expect(after.map((entry) => entry.id)).toEqual(before.map((entry) => entry.id));
    expect(after.filter((entry) => entry.documentIds.includes(id)).every((entry) => entry.preview === '')).toBe(true);
    expect(app.services.decisions.get(decision.id).title).toBe('Wir nehmen Angebot B');
  });

  it('keeps the previews of documents that are not in the trash', async () => {
    const kept = await archivedWithTraces('Bleibt.txt', 'Bleibt: Aprikosenmarmelade');
    const gone = await archivedWithTraces('Geht.txt', `Geht: ${MARKER}`);
    await app.ok('documents:trash', { id: gone, confirmed: true });

    await app.ok('trash:empty', { confirmed: true, permanentlyConfirmed: true });

    const previews = (await app.ok('llm:transmissions', { limit: 100 })).filter((entry) => entry.documentIds.includes(kept));
    expect(previews.some((entry) => entry.preview.toLowerCase().includes('aprikosenmarmelade'))).toBe(true);
  });

  it('also removes the old summary from the undo steps of earlier edits, and the audit chain stays valid', async () => {
    const id = await archivedWithTraces('Neuanalyse.txt', `Altbestand: ${MARKER} zur Neuanalyse.`);
    app.services.database.sqlite.prepare('UPDATE documents SET proposal = NULL WHERE id = ?').run(id);
    app.llm.on('DocumentClassification', () =>
      classification({ title: 'Neu benannt', summary: 'Neue Zusammenfassung.', categoryPath: 'Privat/post', docType: 'Brief' }),
    );
    await app.ok('documents:reprocess', { ids: [id], reread: false, reanalyze: true, confirmLlm: true });
    await app.services.jobs.whenIdle();
    await app.ok('documents:applyReanalysis', { id, confirmed: true });
    await app.ok('documents:bulkUpdate', { ids: [id], addTags: ['blau'], confirmed: true });
    expect(tableText('audit_log'), 'precondition: the undo data keeps the old summary').toContain(MARKER);
    await app.ok('documents:trash', { id, confirmed: true });

    await app.ok('trash:empty', { confirmed: true, permanentlyConfirmed: true });

    expect(tableText('audit_log')).not.toContain(MARKER);
    expect(storedBytes()).not.toContain(MARKER);
    expect(await app.ok('audit:verify', {})).toMatchObject({ chain: 'intact', truncated: false });
  });

  it('keeps the undo of a bulk edit for the documents that stay', async () => {
    const kept = await archivedWithTraces('Bleibt.txt', 'Bleibt: Aprikosenmarmelade');
    const gone = await archivedWithTraces('Geht.txt', `Geht: ${MARKER}`);
    await app.ok('documents:bulkUpdate', { ids: [kept, gone], addTags: ['blau'], confirmed: true });
    await app.ok('documents:trash', { id: gone, confirmed: true });

    await app.ok('trash:empty', { confirmed: true, permanentlyConfirmed: true });

    const bulk = (await app.ok('audit:list', {})).find((entry) => entry.action === 'document.bulkUpdate')!;
    expect((await app.ok('audit:undo', { auditId: bulk.id })).undone).toBe(true);
    expect(app.services.documents.getRow(kept).tags).not.toContain('blau');
    expect(tableText('audit_log')).not.toContain(MARKER);
  });

  it('reports when the database could not be compacted', async () => {
    const id = await archivedWithTraces('Gesperrt.txt', `Gesperrt: ${MARKER}`);
    await app.ok('documents:trash', { id, confirmed: true });
    // a second connection with an open read transaction keeps the write-ahead log from being truncated
    const reader = new Database(app.services.database.file);
    reader.pragma('busy_timeout = 0');
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM documents').get();
    app.services.database.sqlite.pragma('busy_timeout = 0');
    try {
      const result = await app.ok('trash:empty', { confirmed: true, permanentlyConfirmed: true });
      expect(result).toMatchObject({ documents: 1, databaseCompacted: false });
    } finally {
      reader.close();
    }
  });

  it('wipes the text without rewriting the whole database file', async () => {
    const id = await archivedWithTraces('Ohne-Vacuum.txt', longText(`Vertraulich: ${MARKER}.`));
    await app.ok('documents:trash', { id, confirmed: true });

    expect(await app.ok('trash:empty', { confirmed: true, permanentlyConfirmed: true })).toMatchObject({ databaseCompacted: true });

    expect(storedBytes()).not.toContain(MARKER);
    expect(freePages(), 'a VACUUM would leave no free pages').toBeGreaterThan(0);
  });

  it('rewrites a database from before secure deletion once, so text deleted back then is gone too', async () => {
    const { sqlite } = app.services.database;
    sqlite.pragma('user_version = 0');
    sqlite.pragma('secure_delete = OFF');
    const old = await archivedWithTraces('Alt.txt', longText(`Alt: ${MARKER}.`));
    await app.ok('documents:trash', { id: old, confirmed: true });
    sqlite.pragma('secure_delete = ON');

    await app.ok('trash:empty', { confirmed: true, permanentlyConfirmed: true });

    expect(storedBytes()).not.toContain(MARKER);
    expect(freePages(), 'the one-time rewrite').toBe(0);
    const next = await archivedWithTraces('Neu.txt', longText(`Neu: ${MARKER}.`));
    await app.ok('documents:trash', { id: next, confirmed: true });
    await app.ok('trash:empty', { confirmed: true, permanentlyConfirmed: true });
    expect(storedBytes()).not.toContain(MARKER);
    expect(freePages(), 'no second rewrite').toBeGreaterThan(0);
  });

  it('does nothing with the database when the trash is empty', async () => {
    expect(await app.ok('trash:empty', { confirmed: true, permanentlyConfirmed: true })).toEqual({ deletedFiles: 0, documents: 0, databaseCompacted: false });
  });
});
