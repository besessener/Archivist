import path from 'node:path';
import { DatabaseService } from '../../packages/core/src/db/database';
import { Logger } from '../../packages/core/src/util/logger';

/** Renders text as a PNG so that local text recognition (OCR) has something to read. */
export async function writeTextImage(image: { dir: string; name: string; lines: string[] }): Promise<string> {
  const sharp = (await import('sharp')).default;
  const file = path.join(image.dir, image.name);
  const text = image.lines
    .map((line, index) => `<text x="40" y="${100 + index * 100}" font-family="DejaVu Sans, Arial, sans-serif" font-size="56" fill="black">${line}</text>`)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${60 + image.lines.length * 100}"><rect width="100%" height="100%" fill="white"/>${text}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
  return file;
}

/** Creates the database of a large archive before the first start, without importing every file; the first document is the oldest. */
export function seedArchivedDocuments(dataDir: string, docTypes: string[]): void {
  const database = new DatabaseService(path.join(dataDir, 'database', 'archivist.db'), new Logger(null));
  database.migrate(path.resolve(__dirname, '../../packages/core/migrations'));
  const insert = database.sqlite.prepare(
    `INSERT INTO documents (id, title, original_name, ext, mime, size, sha256, status, doc_type, llm_status, created_at, updated_at, archived_at)
     VALUES (?, ?, ?, 'txt', 'text/plain', 1, ?, 'archived', ?, 'local_only', ?, ?, ?)`,
  );
  database.transaction(() =>
    docTypes.forEach((docType, index) => {
      const at = new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString();
      insert.run(`doc-${index}`, `Dokument ${index + 1}`, `dokument-${index + 1}.txt`, `sha-${index}`, docType, at, at, at);
    }),
  );
  database.close();
}

/** Creates the database before the first start with `count` active decisions and `count` open insights (the first ones are the oldest). */
export function seedLongLists(dataDir: string, count: number): void {
  const database = new DatabaseService(path.join(dataDir, 'database', 'archivist.db'), new Logger(null));
  database.migrate(path.resolve(__dirname, '../../packages/core/migrations'));
  const insertDecision = database.sqlite.prepare(
    `INSERT INTO decisions (id, title, decision_text, decided_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
  );
  const insertInsight = database.sqlite.prepare(
    `INSERT INTO insights (id, kind, title, explanation, status, dedupe_key, created_at, updated_at) VALUES (?, 'orphan_document', ?, 'Ohne Zuordnung.', 'open', ?, ?, ?)`,
  );
  database.transaction(() => {
    for (let index = 0; index < count; index++) {
      const at = new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString();
      insertDecision.run(`dec-${index}`, `Entscheidung ${index + 1}`, `Wir entscheiden Nummer ${index + 1}.`, at, at, at);
      insertInsight.run(`ins-${index}`, `Hinweis ${index + 1}`, `seed:${index}`, at, at);
    }
  });
  database.close();
}

/** Creates the database before the first start with `count` proposed decisions (the first one is the oldest). */
export function seedProposedDecisions(dataDir: string, count: number): void {
  const database = new DatabaseService(path.join(dataDir, 'database', 'archivist.db'), new Logger(null));
  database.migrate(path.resolve(__dirname, '../../packages/core/migrations'));
  const insert = database.sqlite.prepare(
    `INSERT INTO agent_actions (id, action_type, label, rationale, confidence, affected_entities, required_confirmation, params, status, created_at)
     VALUES (?, 'record_decision', ?, 'In einem Dokument gefunden.', 0.55, '[]', 'confirm', ?, 'proposed', ?)`,
  );
  database.transaction(() => {
    for (let index = 0; index < count; index++) {
      const at = new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString();
      const params = JSON.stringify({
        title: `Vorschlag ${index + 1}`,
        decisionText: `Wir beschließen Vorschlag ${index + 1}.`,
        participants: [],
        sourceIds: [],
      });
      insert.run(`proposal-${index}`, `Entscheidung erfassen: Vorschlag ${index + 1}`, params, at);
    }
  });
  database.close();
}

/** Deletes the newest entry of the audit log behind the running app's back, as another program on the database could. */
export function cutOffNewestAuditEntry(dataDir: string): void {
  const database = new DatabaseService(path.join(dataDir, 'database', 'archivist.db'), new Logger(null));
  database.sqlite.prepare('DELETE FROM audit_log WHERE rowid = (SELECT max(rowid) FROM audit_log)').run();
  database.close();
}
