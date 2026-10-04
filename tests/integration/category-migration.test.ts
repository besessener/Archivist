import fs from 'node:fs';
import path from 'node:path';
import type { CategoryMigrationResult } from '@archivist/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CategoryService } from '../../packages/core/src/services/categories';
import { CATEGORY_MIGRATION_JOB, germanCategoryPath } from '../../packages/core/src/services/category-migration';
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
const migrationJobs = () => app.services.jobs.list().filter((job) => job.type === CATEGORY_MIGRATION_JOB);
const archivedAt = (...segments: string[]) => fs.existsSync(path.join(archiveRoot(), ...segments));

/** Level 3: both confirmations; the migration runs as a job, whose result this returns. */
async function migrate(): Promise<CategoryMigrationResult> {
  const { jobId } = await app.ok('categories:migrate', { confirmed: true, strongConfirmed: true });
  await app.services.jobs.whenIdle();
  return app.services.jobs.getResult(jobId) as CategoryMigrationResult;
}

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

  it('refuses to run without the second, explicit confirmation (level 3)', async () => {
    legacyArchive();
    const id = await archived('plan.txt', 'work/projects/alpha');

    expect((await app.call('categories:migrate', { confirmed: false, strongConfirmed: true } as never)).ok).toBe(false);
    expect((await app.call('categories:migrate', { confirmed: true } as never)).ok).toBe(false);
    expect((await app.call('categories:migrate', { confirmed: true, strongConfirmed: false } as never)).ok).toBe(false);
    expect(() => app.services.categoryMigration.enqueue({ confirmed: true, strongConfirmed: false })).toThrow('zweite, ausdrückliche Bestätigung');
    await app.services.jobs.whenIdle();

    expect(migrationJobs()).toEqual([]);
    expect(row(id).archiveRelPath).toBe('work/projects/alpha/plan.txt');
  });

  it('moves the files, renames the categories and removes the emptied English ones', async () => {
    legacyArchive();
    const id = await archived('plan.txt', 'work/projects/alpha');

    const result = await migrate();

    expect(migrationJobs()).toEqual([expect.objectContaining({ status: 'succeeded', summary: expect.stringContaining('1 Datei(en) verschoben') })]);
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
    const result = await migrate();

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
    await migrate();
    const entries = await app.ok('audit:list', { limit: 50 });

    for (const entry of entries.filter((e) => ['archive.relocate', 'category.migrate'].includes(e.action) && e.undoable)) {
      expect(await app.ok('audit:undo', { auditId: entry.id })).toMatchObject({ undone: true });
    }

    expect(row(id)).toMatchObject({ categoryPath: 'work/projects/alpha', archiveRelPath: 'work/projects/alpha/plan.txt' });
    expect(fs.readFileSync(path.join(archiveRoot(), 'work', 'projects', 'alpha', 'plan.txt'), 'utf8')).toBe('Inhalt plan.txt');
    expect(categoryPaths()).toEqual(expect.arrayContaining(['work', 'work/projects/alpha']));
  });
});

describe('The migration as a cancellable level-3 job (#233)', () => {
  it('stops between files when cancelled; moved files stay moved and undoable, a re-run moves the rest', async () => {
    legacyArchive();
    const ids = [await archived('a.txt', 'work/projects'), await archived('b.txt', 'work/projects'), await archived('c.txt', 'work/projects')];
    const relocate = app.services.archive.relocate.bind(app.services.archive);
    vi.spyOn(app.services.archive, 'relocate').mockImplementationOnce(async (items, options) => {
      const result = await relocate(items, options);
      app.services.jobs.cancel(migrationJobs()[0]!.id);
      return result;
    });

    await app.ok('categories:migrate', { confirmed: true, strongConfirmed: true });
    await app.services.jobs.whenIdle();

    expect(migrationJobs()[0]!.status).toBe('cancelled');
    const moved = ids.filter((id) => row(id).archiveRelPath!.startsWith('Arbeit/'));
    expect(moved).toHaveLength(1);
    expect(ids.filter((id) => row(id).archiveRelPath!.startsWith('work/'))).toHaveLength(2);
    expect((await app.ok('categories:previewMigration', {})).documentsToMove).toBe(2);
    const relocation = (await app.ok('audit:list', { limit: 50 })).find((entry) => entry.action === 'archive.relocate' && entry.entityIds.includes(moved[0]!));
    expect(relocation?.undoable).toBe(true);

    const rest = await migrate();

    expect(rest).toMatchObject({ moved: 2, failed: 0 });
    expect(ids.map((id) => row(id).archiveRelPath)).toEqual(['Arbeit/projects/a.txt', 'Arbeit/projects/b.txt', 'Arbeit/projects/c.txt']);
    expect(archivedAt('work')).toBe(false);
  });

  it('leaves a file where it is when it was moved out of the English folder by hand and relinked', async () => {
    legacyArchive();
    const id = await archived('hand.txt', 'work/kunden');
    fs.mkdirSync(path.join(archiveRoot(), 'Kunden', 'x'), { recursive: true });
    fs.renameSync(path.join(archiveRoot(), 'work', 'kunden', 'hand.txt'), path.join(archiveRoot(), 'Kunden', 'x', 'hand.txt'));
    await app.ok('archive:relink', { confirmed: true });
    expect(row(id)).toMatchObject({ categoryPath: 'work/kunden', archiveRelPath: 'Kunden/x/hand.txt' });

    const plan = await app.ok('categories:previewMigration', {});
    const result = await migrate();

    expect(plan).toMatchObject({ documentsToMove: 0, notMoved: [], withoutFile: 0 });
    expect(result).toMatchObject({ moved: 0, failed: 0 });
    expect(row(id).archiveRelPath).toBe('Kunden/x/hand.txt');
    expect(archivedAt('Kunden', 'x', 'hand.txt')).toBe(true);
    expect(archivedAt('Arbeit', 'kunden', 'hand.txt')).toBe(false);
  });
});
