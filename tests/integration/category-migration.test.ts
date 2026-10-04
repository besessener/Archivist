import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CategoryService } from '../../packages/core/src/services/categories';
import { germanCategoryPath } from '../../packages/core/src/services/category-migration';
import { createTestApp, type TestApp } from '../helpers/harness';
import { classification } from '../helpers/document-classifications';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const archiveRoot = () => app.services.settings.get().archiveRoot;
const row = (id: string) => app.services.documents.getRow(id);
const categoryPaths = () => app.services.categories.list().map((c) => c.path);
const sql = (query: string, ...params: unknown[]) => app.services.database.sqlite.prepare(query).run(...params);

/** An archive as earlier versions wrote it: English main categories only. */
function legacyArchive() {
  sql("DELETE FROM categories WHERE path IN ('Arbeit', 'Privat')");
  app.services.categories.create('work/projects', { confirmed: true });
  app.services.categories.create('private', { confirmed: true });
}

async function archived(name: string, loc: string, content = `Inhalt ${name}`): Promise<string> {
  app.llm.on('DocumentClassification', () => classification({ title: name, summary: `Zusammenfassung ${name}`, categoryPath: loc }));
  const imp = await app.ok('documents:import', { paths: [app.file(`in/${loc}/${name}`, content)] });
  await app.services.jobs.whenIdle();
  const id = imp.imported[0]!.id;
  await app.ok('documents:archive', {
    items: [{ documentId: id, mode: 'copy', categoryPath: loc }],
    confirmed: true,
    approveNewCategories: ['work', 'private', 'Arbeit'],
    confirmMove: false,
  } as never);
  return id;
}

describe('German main categories (#233)', () => {
  it('a fresh archive starts with Arbeit and Privat', () => {
    expect(categoryPaths()).toEqual(expect.arrayContaining(['Arbeit', 'Privat']));
    expect(categoryPaths()).not.toContain('work');
  });

  it('an archive that still has work/private does not get empty German duplicates at startup', () => {
    legacyArchive();

    new CategoryService(app.services.ctx);

    expect(categoryPaths()).toEqual(expect.arrayContaining(['work', 'private']));
    expect(categoryPaths()).not.toContain('Arbeit');
    expect(categoryPaths()).not.toContain('Privat');
  });

  it('maps only the English main categories', () => {
    expect(germanCategoryPath('work/projects/x')).toBe('Arbeit/projects/x');
    expect(germanCategoryPath('Private')).toBe('Privat');
    expect(germanCategoryPath('workshop/x')).toBeUndefined();
    expect(germanCategoryPath('Arbeit/work')).toBeUndefined();
  });
});

describe('Renaming the English main categories (#233)', () => {
  it('previews what moves without changing anything', async () => {
    legacyArchive();
    const id = await archived('plan.txt', 'work/projects/alpha');

    const plan = await app.ok('categories:previewMigration', {});

    expect(plan).toMatchObject({ documentsToMove: 1, notMoved: [], withoutFile: 0 });
    expect(plan.renames).toEqual(
      expect.arrayContaining([
        { from: 'work', to: 'Arbeit' },
        { from: 'private', to: 'Privat' },
      ]),
    );
    expect(row(id).archiveRelPath).toBe('work/projects/alpha/plan.txt');
    expect(categoryPaths()).not.toContain('Arbeit');
  });

  it('refuses to run without confirmation', async () => {
    const res = await app.call('categories:migrate', { confirmed: false } as never);

    expect(res.ok).toBe(false);
  });

  it('moves the files, renames the categories and removes the emptied English ones', async () => {
    legacyArchive();
    const id = await archived('plan.txt', 'work/projects/alpha');

    const result = await app.ok('categories:migrate', { confirmed: true });

    expect(result).toMatchObject({ moved: 1, notMoved: [], failed: 0 });
    expect(row(id)).toMatchObject({ categoryPath: 'Arbeit/projects/alpha', archiveRelPath: 'Arbeit/projects/alpha/plan.txt' });
    expect(fs.readFileSync(path.join(archiveRoot(), 'Arbeit', 'projects', 'alpha', 'plan.txt'), 'utf8')).toBe('Inhalt plan.txt');
    expect(fs.existsSync(path.join(archiveRoot(), 'work'))).toBe(false);
    expect(categoryPaths()).toEqual(expect.arrayContaining(['Arbeit', 'Arbeit/projects', 'Arbeit/projects/alpha', 'Privat']));
    expect(categoryPaths().filter((p) => /^(work|private)/.test(p))).toEqual([]);
  });

  it('reports a name collision instead of overwriting or merging, and keeps the old category for that file', async () => {
    legacyArchive();
    const mover = await archived('bericht.txt', 'work/projects/alpha', 'alt');
    const blocker = await archived('bericht.txt', 'Arbeit/projects/alpha', 'neu');

    const plan = await app.ok('categories:previewMigration', {});
    const result = await app.ok('categories:migrate', { confirmed: true });

    expect(plan.notMoved).toHaveLength(1);
    expect(result.moved).toBe(0);
    expect(result.notMoved[0]).toMatchObject({ documentId: mover });
    expect(row(mover).archiveRelPath).toBe('work/projects/alpha/bericht.txt');
    expect(fs.readFileSync(path.join(archiveRoot(), 'Arbeit', 'projects', 'alpha', 'bericht.txt'), 'utf8')).toBe('neu');
    expect(row(blocker).archiveRelPath).toBe('Arbeit/projects/alpha/bericht.txt');
    expect(categoryPaths()).toContain('work/projects/alpha');
  });

  it('every move and the removal of the emptied categories can be undone', async () => {
    legacyArchive();
    const id = await archived('plan.txt', 'work/projects/alpha');
    await app.ok('categories:migrate', { confirmed: true });
    const entries = await app.ok('audit:list', { limit: 50 });

    for (const entry of entries.filter((e) => ['archive.relocate', 'category.migrate'].includes(e.action) && e.undoable)) {
      expect(await app.ok('audit:undo', { auditId: entry.id })).toMatchObject({ undone: true });
    }

    expect(row(id)).toMatchObject({ categoryPath: 'work/projects/alpha', archiveRelPath: 'work/projects/alpha/plan.txt' });
    expect(fs.readFileSync(path.join(archiveRoot(), 'work', 'projects', 'alpha', 'plan.txt'), 'utf8')).toBe('Inhalt plan.txt');
    expect(categoryPaths()).toEqual(expect.arrayContaining(['work', 'work/projects/alpha']));
  });
});
