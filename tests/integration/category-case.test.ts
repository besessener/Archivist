import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { classification } from '../helpers/document-classifications';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
  app.services.categories.create('Kunden', { confirmed: true });
});
afterEach(async () => {
  await app.cleanup();
});

const categoryPaths = () => app.services.categories.list().map((c) => c.path);
const sql = (query: string, ...params: unknown[]) => app.services.database.sqlite.prepare(query).run(...params);
const misplaced = () => app.services.insights.list('open').filter((i) => i.kind === 'misplaced_file' && i.title.startsWith('Ablageort passt nicht'));

async function archived(name: string, loc: string): Promise<string> {
  app.llm.on('DocumentClassification', () => classification({ title: name, summary: `Zusammenfassung ${name}`, categoryPath: loc }));
  const imp = await app.ok('documents:import', { paths: [app.file(`in/${name}`, `Inhalt ${name}`)] });
  await app.services.jobs.whenIdle();
  const id = imp.imported[0]!.id;
  await app.ok('documents:archive', {
    items: [{ documentId: id, mode: 'copy', categoryPath: loc }],
    confirmed: true,
    approveNewCategories: [],
    confirmMove: false,
  } as never);
  return id;
}

describe('Categories that differ only in upper/lower case (#244)', () => {
  it('create() reuses the spelling of the existing category instead of adding a second row', () => {
    app.services.categories.create('Kunden/Meier', { confirmed: false });

    const created = app.services.categories.create('kunden/MEIER/Rechnungen', { confirmed: false });

    expect(created.path).toBe('Kunden/Meier/Rechnungen');
    expect(categoryPaths().filter((p) => p.toLowerCase().startsWith('kunden'))).toEqual(['Kunden', 'Kunden/Meier', 'Kunden/Meier/Rechnungen']);
  });

  it('archiving into a differently spelled path stores the canonical category and folder', async () => {
    app.services.categories.create('Kunden/Meier', { confirmed: false });

    const id = await archived('a.txt', 'KUNDEN/meier');

    const row = app.services.documents.getRow(id);
    expect(row.categoryPath).toBe('Kunden/Meier');
    expect(row.archiveRelPath).toBe('Kunden/Meier/a.txt');
  });

  it('the archive check accepts a category that differs only in case from the folder', async () => {
    const id = await archived('b.txt', 'Kunden/Meier');
    sql('UPDATE documents SET category_path = ? WHERE id = ?', 'KUNDEN/meier', id);

    await app.services.consistency.run({ trigger: 'test' });

    expect(misplaced()).toHaveLength(0);
  });

  it('the archive check flags a file in a sibling folder that merely starts with the category name', async () => {
    const id = await archived('c.txt', 'Kunden/Meier2');
    sql('UPDATE documents SET category_path = ? WHERE id = ?', 'Kunden/Meier', id);

    await app.services.consistency.run({ trigger: 'test' });

    expect(misplaced()).toHaveLength(1);
  });

  it('verify does not report a tracked file as untracked when the stored path differs in case', async () => {
    const id = await archived('d.txt', 'Kunden/Meier');
    sql('UPDATE documents SET archive_rel_path = ? WHERE id = ?', 'KUNDEN/MEIER/d.txt', id);

    const report = await app.ok('archive:verify', {});

    expect(report.untrackedFiles).toEqual([]);
  });
});
