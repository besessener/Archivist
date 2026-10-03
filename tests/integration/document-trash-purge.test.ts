import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { documents, llmTransmissions } from '../../packages/core/src/db/schema';
import { newId, nowIso } from '../../packages/core/src/util/ids';
import { DecisionInput } from '@archivist/shared';
import { agentApp, archived } from '../helpers/agent';
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
  const id = await archived(app, { name, content: text, folder: 'private/post' });
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

  it('does nothing with the database when the trash is empty', async () => {
    expect(await app.ok('trash:empty', { confirmed: true, permanentlyConfirmed: true })).toEqual({ deletedFiles: 0, documents: 0, databaseCompacted: false });
  });
});
