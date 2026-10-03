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
