import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { topicNoteClassification } from '../helpers/document-classifications';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
  app.services.settings.update({ llm: { embeddingModel: 'test-embedding' } });
  app.llm.embed = (texts) => texts.map(() => [1, 0, 0]);
  app.llm.on('DocumentClassification', () => topicNoteClassification('Personal'));
});
afterEach(async () => {
  await app.cleanup();
});

/** Transmissions that exist before the indexing under test (the archive step indexes as well). */
let loggedBefore = new Set<string>();

const TOTAL_CHARS = 39_929;
const SECRET = 'hunter2hunter2';

/** A document of exactly `TOTAL_CHARS` characters whose first lines hold a credential. */
function longDocument(): string {
  const paragraphs = Array.from(
    { length: 400 },
    (_, index) => `Absatz ${index}: Die Abteilung prüft den Vorgang ${index} und hält das Ergebnis schriftlich fest.\n\n`,
  );
  return `Zugang: password: ${SECRET}\n\n${paragraphs.join('')}`.slice(0, TOTAL_CHARS);
}

async function archiveLongDocument(): Promise<string> {
  const imported = await app.ok('documents:import', { paths: [app.file('bericht.txt', longDocument())] });
  await app.services.jobs.whenIdle();
  const documentId = imported.imported[0]!.id;
  const items = [{ documentId, mode: 'copy' as const }];
  const plan = await app.ok('documents:previewArchive', { items });
  const result = await app.ok('documents:archive', { items, confirmed: true, approveNewCategories: plan.newCategories, confirmMove: false });
  expect(result.success).toBe(1);
  app.llm.embeddingRequests.length = 0;
  loggedBefore = new Set((await app.ok('llm:transmissions', { limit: 100 })).map((entry) => entry.id));
  await app.services.documents.indexDocument(documentId);
  return documentId;
}

const sentChars = () => app.llm.embeddingRequests.flat().reduce((sum, text) => sum + text.length, 0);

describe('remote embeddings stay within maxInputChars (#204)', () => {
  it('sends at most maxInputChars characters of a long document, however many chunks it has', async () => {
    app.services.settings.update({ llm: { maxInputChars: 2000 } });
    const documentId = await archiveLongDocument();

    expect(sentChars()).toBeGreaterThan(0);
    expect(sentChars()).toBeLessThanOrEqual(2000);
    const rows = app.services.database.sqlite.prepare(
      'SELECT embedding IS NOT NULL AS remote, local_embedding IS NOT NULL AS local FROM chunks WHERE entity_id = ?',
    );
    const chunks = rows.all(documentId) as Array<{ remote: number; local: number }>;
    expect(chunks.length).toBeGreaterThan(app.llm.embeddingRequests.flat().length);
    expect(chunks.filter((chunk) => chunk.remote).length).toBe(app.llm.embeddingRequests.flat().length);
    expect(chunks.every((chunk) => chunk.local)).toBe(true);
  });

  it('records the capped size in the transmission log', async () => {
    app.services.settings.update({ llm: { maxInputChars: 2000 } });
    const documentId = await archiveLongDocument();

    const log = (await app.ok('llm:transmissions', { limit: 100 })).filter((entry) => entry.purpose === 'Suchindex' && !loggedBefore.has(entry.id));
    expect(log.reduce((sum, entry) => sum + entry.bytes, 0)).toBe(Buffer.byteLength(app.llm.embeddingRequests.flat().join('')));
    expect(log.every((entry) => entry.documentIds.includes(documentId))).toBe(true);
  });

  it('masks credentials in what is sent', async () => {
    app.services.settings.update({ llm: { maxInputChars: 2000 } });
    await archiveLongDocument();

    expect(app.llm.embeddingRequests.flat().join('')).not.toContain(SECRET);
    expect(app.llm.embeddingRequests.flat().join('')).toContain('[REDACTED:secret]');
  });

  it('sends more of the document when the limit is raised', async () => {
    app.services.settings.update({ llm: { maxInputChars: 20_000 } });
    await archiveLongDocument();

    expect(sentChars()).toBeGreaterThan(2000);
    expect(sentChars()).toBeLessThanOrEqual(20_000);
  });
});
