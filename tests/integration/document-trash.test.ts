import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentApp, archived, inInbox } from '../helpers/agent';
import type { TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await agentApp();
});
afterEach(async () => {
  await app.cleanup();
});

const row = (id: string) => app.services.documents.findRow(id);
const archiveFile = (id: string) => app.services.documents.archivePath(row(id)!.archiveRelPath)!;
const trashDir = () => app.services.documents.trashEntries();
const searchHits = async (query: string) => (await app.ok('search:global', { query, limit: 10 })).map((hit) => hit.id);

describe('trash: deleting with a safety net', () => {
  it('moves the archive file into the trash, removes the document and keeps the original', async () => {
    const id = await archived(app, { name: 'Mietvertrag Linde.txt', content: 'Mietvertrag Lindenstraße', folder: 'Privat/vertraege' });
    const file = archiveFile(id);
    const original = row(id)!.sourcePath!;

    const { auditId } = await app.ok('documents:trash', { id, confirmed: true });

    expect(row(id)).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(original), "the user's original stays").toBe(true);
    expect(await searchHits('Lindenstraße')).not.toContain(id);
    const [entry] = await app.ok('trash:list');
    expect(entry).toMatchObject({ auditId, documentId: id, title: 'Mietvertrag Linde' });
    expect(entry!.files).toHaveLength(1);
    expect(entry!.files[0]!.startsWith(path.join(app.services.paths.trash, id))).toBe(true);
    expect(fs.readFileSync(entry!.files[0]!, 'utf8')).toBe('Mietvertrag Lindenstraße');
  });

  it('restores file, document, links and search entry via undo', async () => {
    const id = await archived(app, { name: 'Angebot Bad.txt', content: 'Angebot Badsanierung', folder: 'Privat/haus' });
    const topic = app.services.graph.ensureEntity({ type: 'topic', name: 'Bad' });
    app.services.graph.link({ sourceId: id, targetId: topic.id, relationType: 'relates_to' }, { status: 'confirmed' });
    const file = archiveFile(id);
    const { auditId } = await app.ok('documents:trash', { id, confirmed: true });

    const result = await app.ok('audit:undo', { auditId });

    expect(result).toMatchObject({ undone: true, conflicts: [] });
    expect(result.message).toContain('Angebot Bad');
    expect(row(id)).toMatchObject({ id, title: 'Angebot Bad' });
    expect(fs.readFileSync(file, 'utf8')).toBe('Angebot Badsanierung');
    expect(app.services.graph.relationsOf(id).some((relation) => relation.targetEntityId === topic.id)).toBe(true);
    expect(await searchHits('Badsanierung')).toContain(id);
    expect(trashDir()).toEqual([]);
    expect(fs.existsSync(path.join(app.services.paths.trash, id)), 'the empty trash folder is removed').toBe(false);
  });

  it('moves the own inbox copy of a document that is not archived yet and brings it back', async () => {
    const id = await inInbox(app, { name: 'Rechnung Strom.txt', content: 'Rechnung Stadtwerke' });
    const staged = row(id)!.stagedPath!;
    const { auditId } = await app.ok('documents:trash', { id, confirmed: true });
    expect(fs.existsSync(staged)).toBe(false);

    await app.ok('audit:undo', { auditId });

    expect(fs.readFileSync(staged, 'utf8')).toBe('Rechnung Stadtwerke');
    expect(row(id)).toMatchObject({ stagedPath: staged });
  });

  it('never overwrites a file that took the original place meanwhile', async () => {
    const id = await archived(app, { name: 'Notiz.txt', content: 'alter Inhalt', folder: 'Privat/notizen' });
    const file = archiveFile(id);
    const { auditId } = await app.ok('documents:trash', { id, confirmed: true });
    fs.writeFileSync(file, 'neue Datei des Benutzers');

    const result = await app.ok('audit:undo', { auditId });

    expect(result.undone).toBe(false);
    expect(result.conflicts.join(' ')).toContain('Am ursprünglichen Ort liegt inzwischen eine andere Datei');
    expect(fs.readFileSync(file, 'utf8')).toBe('neue Datei des Benutzers');
    expect(row(id)).toBeUndefined();
    expect(trashDir()[0]!.files).toHaveLength(1);
  });

  it('waits for archive file operations: no trash move while a full backup copies the archive', async () => {
    const id = await archived(app, { name: 'Vertrag.txt', content: 'Vertrag', folder: 'Privat/vertraege' });
    const release = app.services.archive.beginBackup();

    const blocked = await app.call('documents:trash', { id, confirmed: true });
    release();

    expect(blocked).toMatchObject({ ok: false, error: { category: 'archive_conflict', retryable: true } });
    expect(row(id)).toBeDefined();
    expect(fs.existsSync(archiveFile(id))).toBe(true);
    await app.ok('documents:trash', { id, confirmed: true });
    expect(row(id)).toBeUndefined();
  });

  it('requires the confirmation to move a document into the trash', async () => {
    const id = await archived(app, { name: 'Brief.txt', content: 'Brief', folder: 'Privat/post' });

    const result = await app.call('documents:trash', { id } as never);

    expect(result).toMatchObject({ ok: false, error: { category: 'validation_error' } });
    expect(row(id)).toBeDefined();
  });

  it('empties the trash only with the second confirmation, then the documents can no longer be restored', async () => {
    const id = await archived(app, { name: 'Kopie.txt', content: 'Kopie', folder: 'Privat/post' });
    const { auditId } = await app.ok('documents:trash', { id, confirmed: true });
    const [trashed] = trashDir()[0]!.files;

    const once = await app.call('trash:empty', { confirmed: true } as never);
    expect(once).toMatchObject({ ok: false, error: { category: 'validation_error' } });
    expect(fs.existsSync(trashed!)).toBe(true);
    await expect(app.services.documents.emptyTrash({ confirmed: true, permanentlyConfirmed: false })).rejects.toThrow('zweite, ausdrückliche Bestätigung');

    expect(await app.ok('trash:empty', { confirmed: true, permanentlyConfirmed: true })).toEqual({ deletedFiles: 1, documents: 1, databaseCompacted: true });

    expect(fs.existsSync(trashed!)).toBe(false);
    expect(trashDir()).toEqual([]);
    const entries = await app.ok('audit:list', { limit: 20, onlyUndoable: false });
    expect(entries.find((entry) => entry.id === auditId)?.undoable).toBe(false);
    expect(entries.find((entry) => entry.action === 'trash.empty')).toMatchObject({ paths: [trashed], confirmed: true });
  });
});
