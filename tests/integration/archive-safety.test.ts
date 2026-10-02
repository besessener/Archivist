import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { makePdf } from '../helpers/fixtures';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
  app.llm.on('DocumentClassification', () => ({
    docType: 'Notiz',
    title: 'Testdokument',
    summary: 'Zusammenfassung',
    mainTopic: 'Test',
    project: null,
    persons: [],
    dates: [],
    tags: [],
    location: { categoryPath: 'work/notes', fileName: null, newMainCategory: false, rationale: 'x', confidence: 0.7 },
    decisions: [],
    openItems: [],
    confidence: 0.7,
    rationale: 'x',
  }));
});
afterEach(async () => {
  await app.cleanup();
});

async function importOne(name: string, content: string, loc?: string) {
  if (loc)
    app.llm.on('DocumentClassification', () => ({
      docType: 'Notiz',
      title: name,
      summary: 's',
      mainTopic: null,
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
  const src = app.file(`in/${name}`, content);
  const imp = await app.ok('documents:import', { paths: [src] });
  await app.services.jobs.whenIdle();
  return { src, id: imp.imported[0]!.id };
}
const archive = (
  items: Array<{ documentId: string; mode: 'copy' | 'move' | 'index_only' | 'ignore'; categoryPath?: string; fileName?: string }>,
  extra: Record<string, unknown> = {},
) => app.ok('documents:archive', { items, confirmed: true, approveNewCategories: [], confirmMove: false, ...extra } as never);

describe('Archiving by copying', () => {
  it('never overwrites existing files but picks a free name', async () => {
    const a = await importOne('bericht.txt', 'Erster Bericht, Inhalt eins');
    const b = await importOne('bericht2.txt', 'Zweiter Bericht, ganz anderer Inhalt');
    const r1 = await archive([{ documentId: a.id, mode: 'copy', fileName: 'bericht.txt' }]);
    const r2 = await archive([{ documentId: b.id, mode: 'copy', fileName: 'bericht.txt' }]);
    expect(path.basename(r1.items[0]!.targetPath!)).toBe('bericht.txt');
    expect(path.basename(r2.items[0]!.targetPath!)).toBe('bericht (2).txt');
    expect(fs.readFileSync(r1.items[0]!.targetPath!, 'utf8')).toContain('Erster');
    expect(fs.readFileSync(r2.items[0]!.targetPath!, 'utf8')).toContain('Zweiter');
  });

  it('shows name conflicts, duplicates and new top-level categories in the plan', async () => {
    const a = await importOne('x.txt', 'Inhalt x ausreichend lang');
    await archive([{ documentId: a.id, mode: 'copy' }]);
    // second document with different content, same target name
    const b = await importOne('x.txt', 'Anderer Inhalt für x');
    const plan = await app.ok('documents:previewArchive', { items: [{ documentId: b.id, mode: 'copy', categoryPath: 'finanzen/steuern' }] });
    expect(plan.newCategories).toEqual(['finanzen']);
    expect(plan.requiresStrongConfirmation).toBe(true);
    const plan2 = await app.ok('documents:previewArchive', { items: [{ documentId: b.id, mode: 'copy' }] });
    expect(plan2.items[0]!.conflicts.join(' ')).toMatch(/existiert bereits/);
    expect(plan2.items[0]!.renamed).toBe(true);
  });

  it('creates new top-level categories only after explicit confirmation', async () => {
    const a = await importOne('s.txt', 'Steuerunterlagen 2026 ausführlich');
    const denied = await archive([{ documentId: a.id, mode: 'copy', categoryPath: 'finanzen/steuern' }]);
    expect(denied.conflicts).toBe(1);
    expect(fs.existsSync(path.join(app.services.paths.archive, 'finanzen'))).toBe(false);
    const ok = await archive([{ documentId: a.id, mode: 'copy', categoryPath: 'finanzen/steuern' }], { approveNewCategories: ['finanzen'] });
    expect(ok.success).toBe(1);
    expect((await app.ok('categories:list', {})).map((c) => c.path)).toContain('finanzen/steuern');
  });

  it('prevents path traversal in the target folder and file name', async () => {
    const a = await importOne('t.txt', 'Traversal-Test Inhalt lang genug');
    const plan = await app.ok('documents:previewArchive', { items: [{ documentId: a.id, mode: 'copy', categoryPath: '../../etc' }] });
    expect(plan.items[0]!.blocked).toBe(true);
    const res = await archive([{ documentId: a.id, mode: 'copy', categoryPath: 'work/../../../etc' }]);
    expect(res.items[0]!.outcome).toBe('conflict');
    const res2 = await archive([{ documentId: a.id, mode: 'copy', categoryPath: 'work/ok', fileName: '../../evil.txt' }]);
    expect(res2.success).toBe(1);
    expect(path.relative(app.services.paths.archive, res2.items[0]!.targetPath!).startsWith('..')).toBe(false);
    expect(path.basename(res2.items[0]!.targetPath!)).not.toContain('/');
  });

  it('prevents escaping via symlinks in the archive', async () => {
    const a = await importOne('l.txt', 'Symlink-Test Inhalt lang genug');
    const outside = path.join(app.root, 'outside');
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(app.services.paths.archive, 'work'), { recursive: true });
    fs.symlinkSync(outside, path.join(app.services.paths.archive, 'work', 'escape'));
    const res = await archive([{ documentId: a.id, mode: 'copy', categoryPath: 'work/escape/deep' }]);
    expect(res.items[0]!.outcome).toBe('conflict');
    expect(fs.readdirSync(outside)).toHaveLength(0);
  });

  it('detects when the source has changed since the analysis', async () => {
    const a = await importOne('c.txt', 'Version eins des Dokuments');
    const staged = (await app.ok('documents:get', { id: a.id })).stagedPath!;
    fs.writeFileSync(staged, 'Verändert!');
    const res = await archive([{ documentId: a.id, mode: 'copy' }]);
    expect(res.items[0]!.outcome).toBe('conflict');
    expect(res.items[0]!.message).toMatch(/verändert/);
  });

  it('archives uploaded files from the inbox and leaves the original untouched; undo restores the inbox', async () => {
    const a = await importOne('u.txt', 'Upload-Dokument mit Inhalt');
    const before = await app.ok('documents:get', { id: a.id });
    expect(before.stagedPath).toContain(path.join('Archivist', 'inbox'));
    const res = await archive([{ documentId: a.id, mode: 'copy' }]);
    expect(fs.existsSync(before.stagedPath!)).toBe(false); // own staging copy moved into the archive
    expect(fs.existsSync(a.src)).toBe(true);
    expect(fs.existsSync(res.items[0]!.targetPath!)).toBe(true);
    const undo = await app.ok('documents:undoArchive', { auditId: res.items[0]!.auditId! });
    expect(undo.undone).toBe(true);
    expect(fs.existsSync(before.stagedPath!)).toBe(true);
    expect(fs.existsSync(res.items[0]!.targetPath!)).toBe(false);
  });

  it('undo reports conflicts when the archived file was changed since, and overwrites nothing', async () => {
    const a = await importOne('k.txt', 'Konflikt-Dokument Inhalt');
    const res = await archive([{ documentId: a.id, mode: 'copy' }]);
    fs.appendFileSync(res.items[0]!.targetPath!, ' (nachträglich bearbeitet)');
    const undo = await app.ok('documents:undoArchive', { auditId: res.items[0]!.auditId! });
    expect(undo.undone).toBe(false);
    expect(undo.conflicts.join(' ')).toMatch(/verändert/);
    expect(fs.readFileSync(res.items[0]!.targetPath!, 'utf8')).toContain('nachträglich');
  });

  it('undo never deletes the only copy', async () => {
    const a = await importOne('o.txt', 'Einzige Kopie Dokument');
    const res = await archive([{ documentId: a.id, mode: 'copy' }]);
    fs.unlinkSync(a.src); // the user's original disappears; the staging copy was moved into the archive → undo would copy it back
    const undo = await app.ok('documents:undoArchive', { auditId: res.items[0]!.auditId! });
    expect(undo.undone).toBe(true); // the staging copy is restored → the file is preserved
    expect(fs.existsSync((await app.ok('documents:get', { id: a.id })).stagedPath!)).toBe(true);
  });
});

describe('Undo after archiving a scanned file (original stays at its source location)', () => {
  async function scanOne(name: string, content: string) {
    app.services.settings.update({ scan: { enabled: true } });
    const dl = path.join(app.home, 'Downloads');
    const src = app.file(`Downloads/${name}`, content);
    await app.ok('scanner:addDirectory', { path: dl, recursive: true });
    await app.ok('scanner:start', {});
    await app.services.jobs.whenIdle();
    const f = (await app.ok('scanner:getResults', {})).files.find((x) => x.name === name)!;
    await app.ok('scanner:analyze', { fileIds: [f.id], confirmLlm: true });
    await app.services.jobs.whenIdle();
    const doc = (await app.ok('documents:list', {})).find((d) => d.originalName === name)!;
    return { src, dl, id: doc.id };
  }

  it('original unchanged: undo removes only the archive copy', async () => {
    const a = await scanOne('gleich.txt', 'Unveränderter Inhalt aus den Downloads');
    const res = await archive([{ documentId: a.id, mode: 'copy' }]);
    const target = res.items[0]!.targetPath!;
    const undo = await app.ok('documents:undoArchive', { auditId: res.items[0]!.auditId! });
    expect(undo.undone).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(a.dl)).toEqual(['gleich.txt']);
  });

  it('original edited after copying: undo puts the archived version back as "Name (2).ext" and deletes nothing', async () => {
    const a = await scanOne('bericht.txt', 'Archivierte Fassung des Berichts');
    const res = await archive([{ documentId: a.id, mode: 'copy' }]);
    const target = res.items[0]!.targetPath!;
    fs.writeFileSync(a.src, 'Später bearbeitete Fassung des Berichts');
    const undo = await app.ok('documents:undoArchive', { auditId: res.items[0]!.auditId! });
    expect(undo.undone).toBe(true);
    expect(undo.message).toContain('bericht (2).txt');
    // the edited original stays untouched, the archived version is not lost
    expect(fs.readFileSync(a.src, 'utf8')).toBe('Später bearbeitete Fassung des Berichts');
    const restored = path.join(a.dl, 'bericht (2).txt');
    expect(fs.readFileSync(restored, 'utf8')).toBe('Archivierte Fassung des Berichts');
    expect(fs.existsSync(target)).toBe(false);
    const doc = await app.ok('documents:get', { id: a.id });
    expect(doc.status).not.toBe('archived');
    expect(doc.archiveRelPath).toBeNull();
    expect(doc.sourcePath).toBe(fs.realpathSync(restored));
  });

  it('original deleted after copying: undo puts the archived version back under the original name', async () => {
    const a = await scanOne('weg.txt', 'Inhalt, dessen Original gelöscht wird');
    const res = await archive([{ documentId: a.id, mode: 'copy' }]);
    fs.unlinkSync(a.src);
    const undo = await app.ok('documents:undoArchive', { auditId: res.items[0]!.auditId! });
    expect(undo.undone).toBe(true);
    expect(fs.readFileSync(a.src, 'utf8')).toBe('Inhalt, dessen Original gelöscht wird');
    expect(fs.existsSync(res.items[0]!.targetPath!)).toBe(false);
  });

  it('original folder missing: undo is refused and the archived version is preserved', async () => {
    const a = await scanOne('ordner.txt', 'Inhalt, dessen Ordner verschwindet');
    const res = await archive([{ documentId: a.id, mode: 'copy' }]);
    fs.rmSync(a.dl, { recursive: true });
    const undo = await app.ok('documents:undoArchive', { auditId: res.items[0]!.auditId! });
    expect(undo.undone).toBe(false);
    expect(undo.conflicts.join(' ')).toMatch(/ursprüngliche Ordner existiert nicht mehr/);
    expect(fs.readFileSync(res.items[0]!.targetPath!, 'utf8')).toBe('Inhalt, dessen Ordner verschwindet');
  });
});

describe('Archive state and processing status', () => {
  it('compares database and file system', async () => {
    const a = await importOne('v.txt', 'Verifikationsdokument Inhalt');
    const res = await archive([{ documentId: a.id, mode: 'copy' }]);
    expect((await app.ok('archive:verify', {})).ok).toBe(true);
    fs.writeFileSync(path.join(app.services.paths.archive, 'work', 'fremd.txt'), 'nicht verwaltet');
    fs.appendFileSync(res.items[0]!.targetPath!, 'x');
    const rep = await app.ok('archive:verify', {});
    expect(rep.ok).toBe(false);
    expect(rep.changedFiles).toHaveLength(1);
    expect(rep.untrackedFiles.some((f) => f.endsWith('fremd.txt'))).toBe(true);
    fs.unlinkSync(res.items[0]!.targetPath!);
    expect((await app.ok('archive:verify', {})).missingFiles).toHaveLength(1);
    // the consistency check reports the missing file
    await app.services.consistency.run('test');
    expect((await app.ok('insights:list', {})).some((i) => i.kind === 'misplaced_file' && i.title.includes('fehlt'))).toBe(true);
  });

  it('does not discard broken files but shows the status and allows reprocessing', async () => {
    const bad = app.file('in/kaputt.pdf', '%PDF-1.4 kein echtes pdf');
    const imp = await app.ok('documents:import', { paths: [bad] });
    await app.services.jobs.whenIdle();
    const d = await app.ok('documents:get', { id: imp.imported[0]!.id });
    expect(d.processingStatus).toBe('failed');
    expect(d.processingError).toBeTruthy();
    expect(d.status).toBe('proposed');
    makePdf(d.stagedPath!, ['Jetzt ist es ein gültiges Dokument zum Test']);
    await app.ok('documents:classify', { documentId: d.id, allowLlm: true });
    await app.services.jobs.whenIdle();
    expect((await app.ok('documents:get', { id: d.id })).processingStatus).toBe('extracted');
  });

  it('rejects wrong file types or quarantines them, and reports unsupported formats', async () => {
    const fake = app.file('in/fake.pdf', 'MZ\x90 das ist keine pdf');
    const exe = app.file('in/tool.exe', 'MZ');
    const empty = app.file('in/leer.txt', '');
    const res = await app.ok('documents:import', { paths: [fake, exe, empty, path.join(app.home, 'in'), '/nicht/vorhanden.txt', 'relativ.txt'] });
    expect(res.imported).toHaveLength(0);
    expect(res.rejected).toHaveLength(6);
    expect(fs.readdirSync(app.services.paths.quarantine)).toContain('fake.pdf');
  });
});
