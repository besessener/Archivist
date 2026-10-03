import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { classification } from '../helpers/document-classifications';
import { intent } from '../helpers/chat-intents';

/** Issue #222: lists capped at a limit must not be presented as the total. */

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const send = (text: string) => app.ok('chat:send', { text });

async function archived(name: string, topic: string | null): Promise<string> {
  app.llm.on('DocumentClassification', () => classification({ title: name, summary: `Zusammenfassung ${name}`, categoryPath: 'work/notes', mainTopic: topic }));
  const imp = await app.ok('documents:import', { paths: [app.file(`in/${name}.txt`, `Inhalt von ${name}`)] });
  await app.services.jobs.whenIdle();
  const id = imp.imported[0]!.id;
  await app.ok('documents:archive', {
    items: [{ documentId: id, mode: 'copy', categoryPath: 'work/notes', topic }],
    confirmed: true,
    approveNewCategories: [],
    confirmMove: false,
  } as never);
  return id;
}

/** Copies straight in the database (real imports would take minutes); `set` holds SQL expressions, `seq.n` numbers the copies. */
function cloneDocs(templateId: string, n: number, set: Record<string, string> = {}): void {
  const db = app.services.database.sqlite;
  const cols = (db.prepare('PRAGMA table_info(documents)').all() as { name: string }[]).map((c) => c.name);
  const exprs = cols.map(
    (c) => set[c] ?? (c === 'id' ? `d.id || '-' || seq.n` : c === 'sha256' ? `d.sha256 || '-' || seq.n` : c === 'text_hash' ? 'NULL' : `d.${c}`),
  );
  db.prepare(
    `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
     INSERT INTO documents (${cols.join(', ')}) SELECT ${exprs.join(', ')} FROM documents d, seq WHERE d.id = ?`,
  ).run(n, templateId);
}

describe('chat', () => {
  it('reports the real number of archived documents, not a list capped at 1000', async () => {
    const id = await archived('Vertrag', null);
    cloneDocs(id, 1199);
    const inbox = (await app.ok('documents:import', { paths: [app.file('in/neu.txt', 'Neuer Inhalt')] })).imported[0]!.id;
    await app.services.jobs.whenIdle();
    cloneDocs(inbox, 4);

    app.llm.on('ChatIntent', () => intent({ intent: 'archive_status' }));
    const r = await send('Wie viele Dokumente gibt es?');
    expect(r.assistantMessage.content).toContain('Archiviert: 1200');
    expect(r.assistantMessage.content).toMatch(/Wartet auf Zuordnung \(Inbox\): 5/);
  });

  it('says how many documents a topic has when it lists only the newest of them', async () => {
    const id = await archived('Protokoll', 'Umzug');
    cloneDocs(id, 59, { title: `'Protokoll ' || seq.n`, created_at: `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || seq.n || ' minutes')` });
    // newer inbox documents of the same topic no longer push archived ones out of the list
    const inbox = (await app.ok('documents:import', { paths: [app.file('in/entwurf.txt', 'Entwurf')] })).imported[0]!.id;
    await app.services.jobs.whenIdle();
    cloneDocs(inbox, 80, { topic_id: `(SELECT topic_id FROM documents WHERE id = '${id}')`, status: `'proposed'` });

    app.llm.on('ChatIntent', () => intent({ intent: 'document_search', topic: 'Umzug', query: 'Umzug' }));
    const r = await send('Welche Dokumente gibt es zum Umzug?');
    expect(r.assistantMessage.content).toMatch(/^Zu „Umzug“ gibt es 60 archivierte Dokumente; hier die 50 neuesten:/);
    expect(r.assistantMessage.sources).toHaveLength(50);
  });

  it('calls a full page of search hits the best hits instead of „N gefunden“', async () => {
    await archived('Rechnung Heizung', null);
    app.llm.on('ChatIntent', () => intent({ intent: 'document_search', query: 'Rechnung Heizung' }));
    expect((await send('Finde die Rechnung zur Heizung')).assistantMessage.content).toMatch(/^Ich habe 1 passende\(s\) Dokument\(e\) gefunden:/);

    for (let i = 0; i < 16; i++) await archived(`Rechnung Heizung ${i}`, null);
    const r = await send('Finde die Rechnung zur Heizung');
    expect(r.assistantMessage.content).toMatch(/^Hier sind die 15 besten Treffer \(es kann weitere passende Dokumente geben\):/);
  });
});

describe('documents:count', () => {
  it('counts what a list filter matches, regardless of the list limit', async () => {
    const id = await archived('Mietvertrag', 'Wohnung');
    cloneDocs(id, 1100);
    const topicId = app.services.documents.getRow(id).topicId!;
    const filter = { statuses: ['archived' as const, 'indexed_only' as const] };
    expect(await app.ok('documents:list', { ...filter, limit: 1000 })).toHaveLength(1000);
    expect(await app.ok('documents:count', filter)).toBe(1101);
    expect(await app.ok('documents:count', { topicId })).toBe(1101);
    expect(await app.ok('documents:count', { query: 'Mietvertrag', status: 'archived' })).toBe(1101);
    expect(await app.ok('documents:count', { status: 'proposed' })).toBe(0);
  });
});
