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

/** Importiert eine Textdatei und archiviert sie (Kopie) in `loc`; `topic` wird dem Dokument zugeordnet. */
async function archived(name: string, content: string, loc: string, topic: string | null = TOPIC): Promise<string> {
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
    items: [{ documentId: id, mode: 'copy', categoryPath: loc, topic }],
    confirmed: true,
    approveNewCategories: [],
    confirmMove: false,
  } as never);
  return id;
}

const categoryNames = (id: string) =>
  app.services.graph
    .relationsOf(id, { types: ['belongs_to'] })
    .filter((r) => r.sourceEntityId === id)
    .map((r) => app.services.graph.getEntity(r.targetEntityId)?.name);

describe('Archivierte Dokumente umlagern', () => {
  it('verschiebt die Datei, passt Datenbank und Wissensgraph an und räumt den leeren Ordner auf', async () => {
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
    expect(fs.existsSync(path.dirname(before)), 'der leere alte Ordner wird entfernt').toBe(false);
    expect(fs.existsSync(path.dirname(path.dirname(before))), 'auch leere Elternordner werden aufgeräumt (wie beim Undo der Archivierung)').toBe(false);
  });

  it('lässt einen Ordner stehen, in dem noch andere Dateien liegen', async () => {
    const a = await archived('a.txt', 'Inhalt A', 'work/hr');
    await archived('b.txt', 'Inhalt B', 'work/hr');
    const oldDir = path.dirname(abs(a));

    await relocate([{ documentId: a, categoryPath: 'work/neu' }]);

    expect(fs.existsSync(oldDir)).toBe(true);
    expect(fs.readdirSync(oldDir)).toEqual(['b.txt']);
  });

  it('überschreibt nie: ist der Name im Zielordner belegt, wird die Datei umbenannt', async () => {
    const a = await archived('bericht.txt', 'Erster Bericht', 'work/a');
    const b = await archived('bericht.txt', 'Zweiter Bericht, anderer Inhalt', 'work/b');

    const res = await relocate([{ documentId: b, categoryPath: 'work/a' }]);

    expect(res.success).toBe(1);
    expect(res.items[0]!.message).toMatch(/umbenannt/);
    expect(fs.readFileSync(abs(a), 'utf8')).toBe('Erster Bericht');
    expect(path.basename(abs(b))).toBe('bericht (2).txt');
    expect(fs.readFileSync(abs(b), 'utf8')).toBe('Zweiter Bericht, anderer Inhalt');
  });

  it('verlangt eine ausdrückliche Bestätigung und ändert vorher nichts', async () => {
    const id = await archived('antrag.txt', 'Antrag', 'work/hr');
    const before = abs(id);

    await expect(relocate([{ documentId: id, categoryPath: 'work/neu' }], false)).rejects.toMatchObject({ category: 'permission_error' });

    expect(fs.existsSync(before)).toBe(true);
    expect(row(id).categoryPath).toBe('work/hr');
  });

  it('die Vorschau ändert nichts und nennt Ziel, Umbenennung und Sperrgründe', async () => {
    const a = await archived('bericht.txt', 'Erster Bericht', 'work/a');
    const b = await archived('bericht.txt', 'Zweiter Bericht, anderer Inhalt', 'work/b');
    const before = abs(b);

    const [plan] = await app.services.archive.previewRelocate([{ documentId: b, categoryPath: 'work/a' }]);

    expect(plan).toMatchObject({ documentId: b, blocked: false, unchanged: false, renamed: true, categoryPath: 'work/a', toRelPath: 'work/a/bericht (2).txt' });
    expect(fs.existsSync(before)).toBe(true);
    expect(row(a).archiveRelPath).toBe('work/a/bericht.txt');
  });

  it('überspringt Dokumente, die schon im Zielordner liegen', async () => {
    const id = await archived('antrag.txt', 'Antrag', 'work/hr');

    const res = await relocate([{ documentId: id, categoryPath: 'work/hr' }]);

    expect(res).toMatchObject({ success: 0, skipped: 1 });
    expect(row(id).archiveRelPath).toBe('work/hr/antrag.txt');
  });

  describe('sperrt, was nicht sicher ist', () => {
    it('Ordner außerhalb des Archivs (Path Traversal) und absolute Pfade', async () => {
      const id = await archived('antrag.txt', 'Antrag', 'work/hr');

      for (const categoryPath of ['../draussen', 'work/../../draussen', '/etc', 'C:\\Windows']) {
        const res = await relocate([{ documentId: id, categoryPath }]);
        expect(res.conflicts, categoryPath).toBe(1);
      }
      expect(row(id).archiveRelPath).toBe('work/hr/antrag.txt');
      expect(fs.existsSync(abs(id))).toBe(true);
    });

    it('einen Zielordner, der über einen Symlink aus dem Archiv herausführt', async () => {
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

    it('eine unbekannte Hauptkategorie (muss erst ausdrücklich angelegt werden)', async () => {
      const id = await archived('antrag.txt', 'Antrag', 'work/hr');

      const res = await relocate([{ documentId: id, categoryPath: 'neuehauptkategorie/unter' }]);

      expect(res.conflicts).toBe(1);
      expect(res.items[0]!.message).toMatch(/Hauptkategorie „neuehauptkategorie“/);
      expect(fs.existsSync(path.join(archiveRoot(), 'neuehauptkategorie'))).toBe(false);
    });

    it('Dokumente, die noch nicht archiviert sind, und fehlende Dateien', async () => {
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

    it('Dateien, die im Archiv seit der Archivierung verändert wurden', async () => {
      const id = await archived('antrag.txt', 'Antrag', 'work/hr');
      fs.appendFileSync(abs(id), ' – nachträglich bearbeitet');

      const res = await relocate([{ documentId: id, categoryPath: 'work/neu' }]);

      expect(res.conflicts).toBe(1);
      expect(res.items[0]!.message).toMatch(/verändert/);
      expect(row(id).archiveRelPath).toBe('work/hr/antrag.txt');
    });
  });

  describe('Rückgängig machen', () => {
    it('legt die Datei an den alten Ort zurück und stellt Datenbank und Wissensgraph wieder her', async () => {
      const id = await archived('antrag.txt', 'Antrag auf Bildungsurlaub', 'work/hr/abwesenheiten');
      const original = abs(id);
      const res = await relocate([{ documentId: id, categoryPath: 'private/bildungsurlaub' }]);

      const undo = await app.ok('audit:undo', { auditId: res.items[0]!.auditId! });

      expect(undo).toMatchObject({ undone: true, conflicts: [] });
      expect(fs.readFileSync(original, 'utf8')).toBe('Antrag auf Bildungsurlaub');
      expect(row(id)).toMatchObject({ archiveRelPath: 'work/hr/abwesenheiten/antrag.txt', categoryPath: 'work/hr/abwesenheiten' });
      expect(categoryNames(id)).toContain('work/hr/abwesenheiten');
      expect(categoryNames(id)).not.toContain('private/bildungsurlaub');
      expect(fs.existsSync(path.join(archiveRoot(), 'private', 'bildungsurlaub')), 'der leere neue Ordner wird entfernt').toBe(false);
    });

    it('lehnt ab, wenn die Datei seit dem Umlagern verändert wurde oder der alte Platz belegt ist', async () => {
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
