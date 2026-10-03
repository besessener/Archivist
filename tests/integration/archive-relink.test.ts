import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classification } from '../helpers/document-classifications';
import { createTestApp, type TestApp } from '../helpers/harness';

// Files renamed or moved outside Archivist are re-attached by their checksum (#239).

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => app.cleanup());

async function archived(name: string, content: string): Promise<{ id: string; file: string }> {
  app.llm.on('DocumentClassification', () =>
    classification({ title: name, summary: `Zusammenfassung ${name}`, categoryPath: 'private/belege', mainTopic: null }),
  );
  const imp = await app.ok('documents:import', { paths: [app.file(`in/${name}`, content)] });
  await app.services.jobs.whenIdle();
  const id = imp.imported[0]!.id;
  const res = await app.ok('documents:archive', {
    items: [{ documentId: id, mode: 'copy', categoryPath: 'private/belege' }],
    confirmed: true,
    approveNewCategories: ['private'],
    confirmMove: false,
  } as never);
  expect(res.success).toBe(1);
  return { id, file: res.items[0]!.targetPath! };
}

/** Renames/moves a file outside Archivist, like the user in the file explorer. */
function moveOutside(file: string, target: string): string {
  const destination = path.join(path.dirname(file), target);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.renameSync(file, destination);
  return destination;
}

describe('Relinking moved archive files', () => {
  it('re-attaches a renamed file, logs it with undo and leaves the file alone', async () => {
    const { id, file } = await archived('miete.txt', 'Mietvertrag Wohnung 4');
    const moved = moveOutside(file, path.join('umbenannt', 'Vertrag Miete.txt'));
    const before = await app.ok('archive:verify', {});
    expect(before.missingFiles).toHaveLength(1);
    expect(before.untrackedFiles).toEqual([moved]);

    const result = await app.ok('archive:relink', { confirmed: true });

    expect(result).toEqual({ relinked: [{ documentId: id, title: 'miete.txt', path: moved }], stillMissing: 0 });
    expect(fs.readFileSync(moved, 'utf8')).toBe('Mietvertrag Wohnung 4');
    expect(app.services.documents.getRow(id).archiveRelPath).toBe('private/belege/umbenannt/Vertrag Miete.txt');
    expect((await app.ok('archive:verify', {})).ok).toBe(true);
    const entry = app.services.audit.list({ limit: 5, onlyUndoable: true }).find((e) => e.action === 'archive.relink');
    expect(entry).toBeTruthy();

    const undo = await app.ok('audit:undo', { auditId: entry!.id });
    expect(undo).toMatchObject({ undone: true, conflicts: [] });
    expect(app.services.documents.getRow(id).archiveRelPath).toBe('private/belege/miete.txt');
    expect(fs.existsSync(moved)).toBe(true);
  });

  it('does not link a file with other content and reports what is still missing', async () => {
    const { file } = await archived('quittung.txt', 'Quittung 12 Euro');
    fs.rmSync(file);
    fs.writeFileSync(path.join(path.dirname(file), 'fremd.txt'), 'Ganz anderer Inhalt!');

    const result = await app.ok('archive:relink', { confirmed: true });

    expect(result).toEqual({ relinked: [], stillMissing: 1 });
  });

  it('links several moved documents, each to the file with its own content', async () => {
    const first = await archived('kopie-a.txt', 'Inhalt von Dokument A');
    const second = await archived('kopie-b.txt', 'Inhalt von Dokument B');
    const movedFirst = moveOutside(first.file, 'a/neu-1.txt');
    const movedSecond = moveOutside(second.file, 'b/neu-2.txt');

    const result = await app.ok('archive:relink', { confirmed: true });

    expect(Object.fromEntries(result.relinked.map((r) => [r.documentId, r.path]))).toEqual({ [first.id]: movedFirst, [second.id]: movedSecond });
    expect((await app.ok('archive:verify', {})).ok).toBe(true);
  });

  it('needs the explicit confirmation', async () => {
    const result = await app.call('archive:relink', {} as never);

    expect(result.ok).toBe(false);
  });
});
