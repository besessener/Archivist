import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'local_only' });
});
afterEach(async () => app.cleanup());

/** SQL statements prepared while `fn` runs. */
async function statementsOf(fn: () => unknown): Promise<string[]> {
  const sqlite = app.services.ctx.database.sqlite;
  const prepare = sqlite.prepare.bind(sqlite);
  const seen: string[] = [];
  const spy = vi.spyOn(sqlite, 'prepare').mockImplementation((sql: string) => {
    seen.push(sql);
    return prepare(sql);
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return seen;
}
/** A statement that reads the whole extracted text – its length or beginning (substr) is fine. */
const readsFullText = (sql: string) =>
  /from "documents"/i.test(sql) &&
  (/select \*/i.test(sql) || sql.replace(/(substr|length)\((?:"documents"\.)?"extracted_text"/gi, '').includes('"extracted_text"'));

async function importText(name: string, text: string): Promise<string> {
  const imp = await app.ok('documents:import', { paths: [app.file(`in/${name}`, text)] });
  await app.services.jobs.whenIdle();
  return imp.imported[0]!.id;
}

describe('Document lists without full texts (#214)', () => {
  it('reads only the beginning of the texts, but reports the full length and a preview', async () => {
    const long = `Anfang des Dokuments. ${'Lorem ipsum dolor sit amet. '.repeat(400)}`;
    const id = await importText('lang.txt', long);

    let list: Awaited<ReturnType<typeof app.ok<'documents:list'>>> = [];
    const sql = await statementsOf(async () => {
      list = await app.ok('documents:list', { limit: 1000 });
    });

    expect(sql.filter(readsFullText)).toEqual([]);
    const doc = list.find((d) => d.id === id)!;
    expect(doc.textLength).toBe((await app.ok('documents:get', { id })).textLength);
    expect(doc.textLength).toBeGreaterThan(5000);
    expect(doc.textPreview).toMatch(/^Anfang des Dokuments\./);
  });

  it('filters by several statuses and ids in the database; counts per status', async () => {
    const waiting = await importText('alt.txt', 'Ein älteres Dokument wartet im Eingang.');
    const archivedId = await importText('neu.txt', 'Ein neueres Dokument wird archiviert.');
    const sqlite = app.services.ctx.database.sqlite;
    sqlite.prepare("UPDATE documents SET status = 'archived'").run();
    sqlite.prepare("UPDATE documents SET status = 'proposed' WHERE id = ?").run(waiting);

    const inbox = await app.ok('documents:list', { statuses: ['staged', 'proposed'], limit: 1 });
    expect(inbox.map((d) => d.id)).toEqual([waiting]);
    expect((await app.ok('documents:list', { ids: [archivedId] })).map((d) => d.id)).toEqual([archivedId]);
    expect(await app.ok('documents:counts', {})).toEqual({ proposed: 1, archived: 1 });
  });

  it('the timeline reads no full texts', async () => {
    const id = await importText('t.txt', 'Zeitleistentext');
    app.services.ctx.database.sqlite.prepare("UPDATE documents SET status = 'archived', archived_at = '2026-01-01'").run();
    let entries: Array<{ id: string }> = [];
    const sql = await statementsOf(async () => {
      entries = await app.ok('timeline:get', {});
    });
    expect(sql.filter(readsFullText)).toEqual([]);
    expect(entries.some((e) => e.id === `doc:${id}`)).toBe(true);
  });
});
