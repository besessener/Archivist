import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeAll(async () => {
  app = await createTestApp({ configured: false });
}, 120_000);
afterAll(async () => app.cleanup());

describe('keyword search with ß (#161)', () => {
  it.each(['Maßnahme', 'Massnahme', 'Straße', 'Strasse'])('finds the ß spelling with the query "%s"', async (query) => {
    const note = await app.services.notes.create({ title: 'Verkehr', content: 'Die Maßnahme betrifft die Straße am Markt.' });
    const hits = await app.services.search.search(query, { limit: 5 });
    expect(hits.map((hit) => hit.id)).toContain(note.id);
  });
});
