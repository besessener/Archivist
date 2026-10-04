import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

const ROWS = 33_000; // above SQLite's default limit of 32,766 bound variables

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

function insertAnalyzedScanFiles(): string[] {
  const { sqlite } = app.services.database;
  const now = '2026-01-01T00:00:00.000Z';
  const proposal = JSON.stringify({ topic: 'Massentest', project: null, location: { categoryPath: 'Privat/Test' }, possibleDecisions: [] });
  sqlite.prepare("INSERT INTO scan_roots (id, path, created_at) VALUES ('root', '/tmp/massentest', ?)").run(now);
  const insertDocument = sqlite.prepare(
    `INSERT INTO documents (id, title, original_name, ext, mime, size, sha256, status, proposal, category_path, confidence, extracted_text, created_at, updated_at)
     VALUES (?, ?, ?, 'txt', 'text/plain', 1, ?, 'proposed', ?, 'Privat/Test', 0.9, ?, ?, ?)`,
  );
  const insertFile = sqlite.prepare(
    `INSERT INTO scan_files (id, root_id, path, name, ext, size, mtime_ms, sha256, mime, status, document_id, first_seen_at, last_seen_at)
     VALUES (?, 'root', ?, ?, 'txt', 1, 1, ?, 'text/plain', 'analyzed', ?, ?, ?)`,
  );
  const ids: string[] = [];
  sqlite.transaction(() => {
    for (let index = 0; index < ROWS; index += 1) {
      const id = `doc-${index}`;
      ids.push(id);
      insertDocument.run(id, `Datei ${index}`, `datei-${index}.txt`, `sha-${index}`, proposal, 'x'.repeat(200), now, now);
      insertFile.run(`file-${index}`, `/tmp/massentest/datei-${index}.txt`, `datei-${index}.txt`, `sha-${index}`, id, now, now);
    }
  })();
  return ids;
}

describe('scan proposals above the SQL variable limit', () => {
  it('groups more than 32,766 analyzed scan files without "too many SQL variables"', async () => {
    insertAnalyzedScanFiles();
    const groups = await app.ok('scanner:proposals', {});
    expect(groups).toHaveLength(1);
    expect(groups[0]!.documentIds).toHaveLength(ROWS);
  });

  it('plans the proposals of an analysis batch above the limit', () => {
    const ids = insertAnalyzedScanFiles();
    const plans = [...app.services.scanner['scanProposals'].plans(ids)];
    expect(plans).toHaveLength(1);
    expect(plans[0]!.insight.affected).toHaveLength(ROWS);
  });
});
