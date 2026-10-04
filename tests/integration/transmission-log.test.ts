import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { llmTransmissions } from '../../packages/core/src/db/schema';
import { newId } from '../../packages/core/src/util/ids';
import { archived } from '../helpers/agent';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
  app.llm.on('KnowledgeAnswer', () => ({
    answer: 'Antwort.',
    facts: [],
    uncertainties: [],
    contradictions: [],
    missingInformation: [],
    usedSourceIds: ['S1'],
    confidence: 0.8,
  }));
  app.llm.on('ChatIntent', () => ({ intent: 'knowledge_question', confidence: 0.9, rationale: 'test', query: 'Dachdecker Kowalski' }));
});
afterEach(async () => {
  await app.cleanup();
});

const DAY_MS = 24 * 60 * 60 * 1000;
function insertEntry(values: { at: Date; purpose?: string; documentIds?: string[] }): string {
  const id = newId();
  app.services.database.db
    .insert(llmTransmissions)
    .values({ id, at: values.at.toISOString(), purpose: values.purpose ?? 'Test', model: 'm', endpoint: 'e', bytes: 1, documentIds: values.documentIds ?? [] })
    .run();
  return id;
}

describe('transmission log (#211)', () => {
  it('shows the question and the source titles instead of the prompt frame, masked', async () => {
    const id = await archived(app, { name: 'Angebot Dachdecker Kowalski.md', content: 'Angebot Dachdecker Kowalski: 4.800 Euro.', folder: 'Privat/haus' });

    await app.ok('chat:send', { text: 'Was kostet der Dachdecker Kowalski? Meine PIN 4711' });

    const entry = (await app.ok('llm:transmissions', {})).find((transmission) => transmission.purpose === 'Wissensabfrage');
    expect(entry?.preview).toMatch(/^Frage: Was kostet der Dachdecker Kowalski\? Meine PIN \[PIN\] \| Quellen: /);
    expect(entry?.preview).toContain('Angebot Dachdecker Kowalski');
    expect(entry?.preview).not.toMatch(/Antworte als JSON|Heutiges Datum/);
    expect(entry?.documents).toEqual([{ id, title: 'Angebot Dachdecker Kowalski' }]);
  });

  it('shows the file name and the text start for the analysis of a document and a plain preview without the frame otherwise', async () => {
    await archived(app, { name: 'Rechnung.txt', content: 'Rechnung Nr. 17 über 300 Euro', folder: 'Privat/haus' });

    const classification = (await app.ok('llm:transmissions', {})).find((entry) => entry.purpose.startsWith('Dokumentklassifikation'));
    expect(classification?.preview).toBe('Datei: Rechnung.txt | Textanfang: Rechnung Nr. 17 über 300 Euro');
  });

  it('names the documents of an entry and marks a document that is gone', async () => {
    const id = await archived(app, { name: 'Mietvertrag.txt', content: 'Mietvertrag', folder: 'Privat/haus' });
    const entry = insertEntry({ at: new Date(), documentIds: [id, 'weg'] });

    const listed = (await app.ok('llm:transmissions', {})).find((transmission) => transmission.id === entry);

    expect(listed?.documents).toEqual([
      { id, title: 'Mietvertrag' },
      { id: 'weg', title: null },
    ]);
  });

  it('pages through the entries newest first without gaps or repeats', async () => {
    const now = Date.now();
    const ids = Array.from({ length: 7 }, (_, index) => insertEntry({ at: new Date(now - index * 1000), purpose: `Eintrag ${index}` }));

    const first = await app.ok('llm:transmissions', { limit: 3 });
    const second = await app.ok('llm:transmissions', { limit: 3, offset: 3 });
    const third = await app.ok('llm:transmissions', { limit: 3, offset: 6 });

    expect([...first, ...second, ...third].map((entry) => entry.id)).toEqual(ids);
  });

  it('deletes entries older than the given number of days and keeps the rest', () => {
    const now = Date.now();
    const old = insertEntry({ at: new Date(now - 91 * DAY_MS) });
    const recent = insertEntry({ at: new Date(now - 89 * DAY_MS) });

    expect(app.services.llm.pruneTransmissions(90)).toBe(1);

    const remaining = app.services.database.db.select({ id: llmTransmissions.id }).from(llmTransmissions).all();
    expect(remaining.map((row) => row.id)).toEqual([recent]);
    expect(app.services.database.db.select().from(llmTransmissions).where(eq(llmTransmissions.id, old)).all()).toEqual([]);
  });

  it('prunes by `logs.retentionDays` when the application starts', () => {
    app.services.settings.update({ logs: { retentionDays: 30 } });
    insertEntry({ at: new Date(Date.now() - 45 * DAY_MS) });

    app.services.start();

    expect(app.services.database.db.select().from(llmTransmissions).all()).toEqual([]);
  });
});
