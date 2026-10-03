import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
afterEach(async () => app.cleanup());

describe('Archive check reads no full texts (#213)', () => {
  it('runs without selecting extracted_text and still finds duplicates by text hash', async () => {
    app = await createTestApp({ privacy: 'local_only' });
    const text = 'Rechnung Nr. 4711 über die Wartung der Heizungsanlage im Haus Musterstraße 1, fällig in vier Wochen. '.repeat(4);
    for (const name of ['a.txt', 'b.txt']) {
      const imp = await app.ok('documents:import', { paths: [app.file(`in/${name}`, `${text}${name === 'b.txt' ? ' ' : ''}`)] });
      await app.services.jobs.whenIdle();
      const id = imp.imported[0]!.id;
      await app.ok('documents:archive', {
        items: [{ documentId: id, mode: 'copy', categoryPath: 'private/rechnungen' }],
        confirmed: true,
        approveNewCategories: ['private'],
        confirmMove: false,
      } as never);
    }

    const sqlite = app.services.ctx.database.sqlite;
    const statements: string[] = [];
    const prepare = sqlite.prepare.bind(sqlite);
    const spy = vi.spyOn(sqlite, 'prepare').mockImplementation((sql: string) => {
      statements.push(sql);
      return prepare(sql);
    });
    try {
      await app.services.consistency.run();
    } finally {
      spy.mockRestore();
    }

    expect(statements.filter((s) => /from "documents"/i.test(s) && /extracted_text|select \*/i.test(s))).toEqual([]);
    const insights = await app.ok('insights:list', {});
    expect(insights.some((i) => i.kind === 'duplicate')).toBe(true);
  });
});

describe('Archive check yields to the event loop (#215)', () => {
  it('other callbacks (IPC) run between its sections; missing archive files are still found', async () => {
    app = await createTestApp({ privacy: 'local_only' });
    const imp = await app.ok('documents:import', { paths: [app.file('in/x.txt', 'Eine Quittung über 12 Euro.')] });
    await app.services.jobs.whenIdle();
    const id = imp.imported[0]!.id;
    app.services.ctx.database.sqlite
      .prepare("UPDATE documents SET status = 'archived', archive_rel_path = 'private/fehlt/x.txt', category_path = 'private/fehlt' WHERE id = ?")
      .run(id);

    const reports: string[] = [];
    const running = app.services.consistency.run({ trigger: 'manual', report: (_p, m) => reports.push(m) });
    const seenByOtherCallback = await new Promise<string[]>((resolve) => setImmediate(() => resolve([...reports])));
    await running;

    expect(seenByOtherCallback).not.toContain('Prüfe Verzeichnisse');
    expect(reports).toContain('Prüfe Verzeichnisse');
    const insights = await app.ok('insights:list', {});
    expect(insights.some((i) => i.kind === 'misplaced_file' && i.title.includes('Archivdatei fehlt'))).toBe(true);
  });
});
