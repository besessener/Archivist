import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

const TOPIC = 'Bildungsurlaub 2026';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const archiveRoot = () => app.services.settings.get().archiveRoot;
const row = (id: string) => app.services.documents.getRow(id);
const abs = (id: string) => path.join(archiveRoot(), ...row(id).archiveRelPath!.split('/'));
const relocate = (items: Array<{ documentId: string; categoryPath: string }>, confirmed = true) => app.services.archive.relocate(items, { confirmed });

/** Imports a text file and archives it (copy) into `loc`; `topic` is assigned to the document. */
async function archived(name: string, content: string, loc: string, topic: string | null = TOPIC, mode: 'copy' | 'move' = 'copy'): Promise<string> {
  app.llm.on('DocumentClassification', () => ({
    docType: 'Notiz',
    title: name,
    summary: `Zusammenfassung ${name}`,
    mainTopic: topic,
    project: null,
    persons: [],
    dates: [],
    tags: [],
    location: { categoryPath: loc, fileName: null, newMainCategory: false, rationale: 'x', confidence: 0.7 },
    decisions: [],
    openItems: [],
    confidence: 0.7,
    rationale: 'x',
  }));
  const imp = await app.ok('documents:import', { paths: [app.file(`in/${name}`, content)] });
  await app.services.jobs.whenIdle();
  const id = imp.imported[0]!.id;
  await app.ok('documents:archive', {
    items: [{ documentId: id, mode, categoryPath: loc, topic }],
    confirmed: true,
    approveNewCategories: [],
    confirmMove: mode === 'move',
  } as never);
  return id;
}

/** The document's belongs_to relation to the category `name` (any status). */
const categoryRelation = (id: string, name: string) =>
  app.services.graph
    .relationsOf(id, { types: ['belongs_to'] })
    .find((r) => r.sourceEntityId === id && app.services.graph.getEntity(r.targetEntityId)?.name === name);

const categoryNames = (id: string) =>
  app.services.graph
    .relationsOf(id, { types: ['belongs_to'] })
    .filter((r) => r.sourceEntityId === id)
    .map((r) => app.services.graph.getEntity(r.targetEntityId)?.name);

describe('Relocating archived documents', () => {
  it('moves the file, updates the database and knowledge graph and cleans up the empty folder', async () => {
    const id = await archived('antrag.txt', 'Antrag auf Bildungsurlaub', 'work/hr/abwesenheiten');
    const before = abs(id);
    expect(categoryNames(id)).toContain('work/hr/abwesenheiten');

    const res = await relocate([{ documentId: id, categoryPath: 'private/bildungsurlaub/2026' }]);

    expect(res).toMatchObject({ success: 1, skipped: 0, failed: 0, conflicts: 0 });
    expect(fs.existsSync(before)).toBe(false);
    expect(fs.readFileSync(abs(id), 'utf8')).toBe('Antrag auf Bildungsurlaub');
    expect(row(id)).toMatchObject({ categoryPath: 'private/bildungsurlaub/2026', status: 'archived' });
    expect(row(id).archiveRelPath).toBe('private/bildungsurlaub/2026/antrag.txt');
    expect(categoryNames(id)).toContain('private/bildungsurlaub/2026');
    expect(categoryNames(id)).not.toContain('work/hr/abwesenheiten');
    expect(fs.existsSync(path.dirname(before)), 'the empty old folder is removed').toBe(false);
    expect(fs.existsSync(path.dirname(path.dirname(before))), 'empty parent folders are cleaned up too (as with undoing an archiving)').toBe(false);
  });

  it('leaves a folder in place that still contains other files', async () => {
    const a = await archived('a.txt', 'Inhalt A', 'work/hr');
    await archived('b.txt', 'Inhalt B', 'work/hr');
    const oldDir = path.dirname(abs(a));

    await relocate([{ documentId: a, categoryPath: 'work/neu' }]);

    expect(fs.existsSync(oldDir)).toBe(true);
    expect(fs.readdirSync(oldDir)).toEqual(['b.txt']);
  });

  it('never overwrites: if the name is taken in the target folder, the file is renamed', async () => {
    const a = await archived('bericht.txt', 'Erster Bericht', 'work/a');
    const b = await archived('bericht.txt', 'Zweiter Bericht, anderer Inhalt', 'work/b');

    const res = await relocate([{ documentId: b, categoryPath: 'work/a' }]);

    expect(res.success).toBe(1);
    expect(res.items[0]!.message).toMatch(/umbenannt/);
    expect(fs.readFileSync(abs(a), 'utf8')).toBe('Erster Bericht');
    expect(path.basename(abs(b))).toBe('bericht (2).txt');
    expect(fs.readFileSync(abs(b), 'utf8')).toBe('Zweiter Bericht, anderer Inhalt');
  });

  it('requires explicit confirmation and changes nothing before', async () => {
    const id = await archived('antrag.txt', 'Antrag', 'work/hr');
    const before = abs(id);

    await expect(relocate([{ documentId: id, categoryPath: 'work/neu' }], false)).rejects.toMatchObject({ category: 'permission_error' });

    expect(fs.existsSync(before)).toBe(true);
    expect(row(id).categoryPath).toBe('work/hr');
  });

  it('the preview changes nothing and names target, renaming and blocking reasons', async () => {
    const a = await archived('bericht.txt', 'Erster Bericht', 'work/a');
    const b = await archived('bericht.txt', 'Zweiter Bericht, anderer Inhalt', 'work/b');
    const before = abs(b);

    const [plan] = await app.services.archive.previewRelocate([{ documentId: b, categoryPath: 'work/a' }]);

    expect(plan).toMatchObject({ documentId: b, blocked: false, unchanged: false, renamed: true, categoryPath: 'work/a', toRelPath: 'work/a/bericht (2).txt' });
    expect(fs.existsSync(before)).toBe(true);
    expect(row(a).archiveRelPath).toBe('work/a/bericht.txt');
  });

  it('skips documents that are already in the target folder', async () => {
    const id = await archived('antrag.txt', 'Antrag', 'work/hr');

    const res = await relocate([{ documentId: id, categoryPath: 'work/hr' }]);

    expect(res).toMatchObject({ success: 0, skipped: 1 });
    expect(row(id).archiveRelPath).toBe('work/hr/antrag.txt');
  });

  describe('blocks what is not safe', () => {
    it('folders outside the archive (path traversal) and absolute paths', async () => {
      const id = await archived('antrag.txt', 'Antrag', 'work/hr');

      for (const categoryPath of ['../draussen', 'work/../../draussen', '/etc', 'C:\\Windows']) {
        const res = await relocate([{ documentId: id, categoryPath }]);
        expect(res.conflicts, categoryPath).toBe(1);
      }
      expect(row(id).archiveRelPath).toBe('work/hr/antrag.txt');
      expect(fs.existsSync(abs(id))).toBe(true);
    });

    it('a target folder that leads out of the archive via a symlink', async () => {
      const id = await archived('antrag.txt', 'Antrag', 'work/hr');
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-outside-'));
      try {
        fs.symlinkSync(outside, path.join(archiveRoot(), 'work', 'tunnel'));

        const res = await relocate([{ documentId: id, categoryPath: 'work/tunnel' }]);

        expect(res.conflicts).toBe(1);
        expect(fs.readdirSync(outside)).toEqual([]);
        expect(fs.existsSync(abs(id))).toBe(true);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it('an unknown top-level category (must be created explicitly first)', async () => {
      const id = await archived('antrag.txt', 'Antrag', 'work/hr');

      const res = await relocate([{ documentId: id, categoryPath: 'neuehauptkategorie/unter' }]);

      expect(res.conflicts).toBe(1);
      expect(res.items[0]!.message).toMatch(/Hauptkategorie „neuehauptkategorie“/);
      expect(fs.existsSync(path.join(archiveRoot(), 'neuehauptkategorie'))).toBe(false);
    });

    it('documents that are not archived yet, and missing files', async () => {
      app.llm.on('DocumentClassification', () => ({
        docType: 'Notiz',
        title: 'offen',
        summary: 's',
        mainTopic: null,
        project: null,
        persons: [],
        dates: [],
        tags: [],
        location: { categoryPath: 'work/x', fileName: null, newMainCategory: false, rationale: 'x', confidence: 0.7 },
        decisions: [],
        openItems: [],
        confidence: 0.7,
        rationale: 'x',
      }));
      const imp = await app.ok('documents:import', { paths: [app.file('in/offen.txt', 'noch in der Inbox')] });
      await app.services.jobs.whenIdle();
      const inbox = imp.imported[0]!.id;
      const gone = await archived('weg.txt', 'wird gelöscht', 'work/hr');
      fs.rmSync(abs(gone));

      const res = await relocate([
        { documentId: inbox, categoryPath: 'work/neu' },
        { documentId: gone, categoryPath: 'work/neu' },
      ]);

      expect(res.conflicts).toBe(2);
      expect(res.items[0]!.message).toMatch(/Nur archivierte Dokumente/);
      expect(res.items[1]!.message).toMatch(/fehlt/);
    });

    it('files that were changed in the archive since archiving', async () => {
      const id = await archived('antrag.txt', 'Antrag', 'work/hr');
      fs.appendFileSync(abs(id), ' – nachträglich bearbeitet');

      const res = await relocate([{ documentId: id, categoryPath: 'work/neu' }]);

      expect(res.conflicts).toBe(1);
      expect(res.items[0]!.message).toMatch(/verändert/);
      expect(row(id).archiveRelPath).toBe('work/hr/antrag.txt');
    });
  });

  describe('Undo', () => {
    it('puts the file back at its old location and restores the database and knowledge graph', async () => {
      const id = await archived('antrag.txt', 'Antrag auf Bildungsurlaub', 'work/hr/abwesenheiten');
      const original = abs(id);
      const res = await relocate([{ documentId: id, categoryPath: 'private/bildungsurlaub' }]);

      const undo = await app.ok('audit:undo', { auditId: res.items[0]!.auditId! });

      expect(undo).toMatchObject({ undone: true, conflicts: [] });
      expect(fs.readFileSync(original, 'utf8')).toBe('Antrag auf Bildungsurlaub');
      expect(row(id)).toMatchObject({ archiveRelPath: 'work/hr/abwesenheiten/antrag.txt', categoryPath: 'work/hr/abwesenheiten' });
      expect(categoryNames(id)).toContain('work/hr/abwesenheiten');
      expect(categoryNames(id)).not.toContain('private/bildungsurlaub');
      expect(fs.existsSync(path.join(archiveRoot(), 'private', 'bildungsurlaub')), 'the empty new folder is removed').toBe(false);
    });

    it('relocate, undo relocate, then undo archiving succeeds and puts the moved original back', async () => {
      const id = await archived('antrag.txt', 'Antrag auf Bildungsurlaub', 'work/hr', TOPIC, 'move');
      const source = row(id).sourcePath!;
      const archiveAudit = app.services.audit.list().find((e) => e.action === 'archive.move' && e.entityIds.includes(id))!;
      expect(fs.existsSync(source)).toBe(false);
      const archivedRelation = categoryRelation(id, 'work/hr')!;

      const res = await relocate([{ documentId: id, categoryPath: 'work/neu' }]);
      expect(await app.ok('audit:undo', { auditId: res.items[0]!.auditId! })).toMatchObject({ undone: true });
      expect(categoryRelation(id, 'work/hr'), 'the relation comes back with its id').toEqual(archivedRelation);

      const undo = await app.ok('audit:undo', { auditId: archiveAudit.id });

      expect(undo).toMatchObject({ undone: true, conflicts: [] });
      expect(fs.readFileSync(source, 'utf8')).toBe('Antrag auf Bildungsurlaub');
      expect(row(id).status).not.toBe('archived');
      expect(row(id).archiveRelPath).toBeNull();
      expect(categoryNames(id), 'archive undo removes the category relation it created').toEqual([]);
    });

    it('keeps a rejected relation to the old category through relocate and its undo', async () => {
      const id = await archived('antrag.txt', 'Antrag', 'work/hr');
      app.services.graph.setRelationStatus(categoryRelation(id, 'work/hr')!.id, 'rejected');
      const rejected = categoryRelation(id, 'work/hr')!;

      const res = await relocate([{ documentId: id, categoryPath: 'work/neu' }]);

      expect(categoryRelation(id, 'work/hr')).toEqual(rejected);
      expect(categoryRelation(id, 'work/neu')).toMatchObject({ status: 'confirmed' });

      const undo = await app.ok('audit:undo', { auditId: res.items[0]!.auditId! });

      expect(undo).toMatchObject({ undone: true, conflicts: [] });
      expect(categoryRelation(id, 'work/hr'), 'still rejected, not recreated as confirmed').toEqual(rejected);
      expect(categoryRelation(id, 'work/neu')).toBeUndefined();
    });

    it('confirms an earlier rejected relation to the target category and restores it exactly on undo', async () => {
      const id = await archived('antrag.txt', 'Antrag', 'work/hr');
      const target = app.services.graph.ensureEntity('category', 'work/neu');
      const link = app.services.graph.link(id, target.id, 'belongs_to', { confidence: 0.4, status: 'proposed', sourceIds: [id] })!;
      app.services.graph.setRelationStatus(link.id, 'rejected');
      const rejected = app.services.graph.getRelation(link.id)!;

      const res = await relocate([{ documentId: id, categoryPath: 'work/neu' }]);

      expect(app.services.graph.getRelation(link.id)).toMatchObject({ status: 'confirmed' });
      expect(categoryRelation(id, 'work/hr')).toBeUndefined();

      const undo = await app.ok('audit:undo', { auditId: res.items[0]!.auditId! });

      expect(undo).toMatchObject({ undone: true, conflicts: [] });
      expect(app.services.graph.getRelation(link.id)).toEqual(rejected);
      expect(categoryRelation(id, 'work/hr')).toMatchObject({ status: 'confirmed' });
    });

    it('refuses when the user decided on the new category relation after relocating', async () => {
      const id = await archived('antrag.txt', 'Antrag', 'work/hr');
      const res = await relocate([{ documentId: id, categoryPath: 'work/neu' }]);
      app.services.graph.setRelationStatus(categoryRelation(id, 'work/neu')!.id, 'rejected');

      const undo = await app.ok('audit:undo', { auditId: res.items[0]!.auditId! });

      expect(undo.undone).toBe(false);
      expect(undo.conflicts.join(' ')).toMatch(/Zuordnung zur Kategorie „work\/neu“/);
      expect(categoryRelation(id, 'work/neu')).toMatchObject({ status: 'rejected' });
      expect(row(id).archiveRelPath).toBe('work/neu/antrag.txt');
    });

    it('refuses when the file was changed since relocating or the old location is taken', async () => {
      const id = await archived('antrag.txt', 'Antrag', 'work/hr');
      const original = abs(id);
      const res = await relocate([{ documentId: id, categoryPath: 'work/neu' }]);
      fs.appendFileSync(abs(id), ' geändert');
      fs.mkdirSync(path.dirname(original), { recursive: true });
      fs.writeFileSync(original, 'fremde Datei am alten Ort');

      const undo = await app.ok('audit:undo', { auditId: res.items[0]!.auditId! });

      expect(undo.undone).toBe(false);
      expect(undo.conflicts.join(' ')).toMatch(/verändert/);
      expect(undo.conflicts.join(' ')).toMatch(/existiert bereits/);
      expect(fs.readFileSync(original, 'utf8')).toBe('fremde Datei am alten Ort');
      expect(row(id).archiveRelPath).toBe('work/neu/antrag.txt');
    });
  });
});
