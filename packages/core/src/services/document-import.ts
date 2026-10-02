import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { SUPPORTED_EXTENSIONS, type DocumentRecord } from '@archivist/shared';
import { and, eq } from 'drizzle-orm';
import { documents } from '../db/schema';
import { AppError, fsError } from '../util/errors';
import { sha256File } from '../util/hash';
import { nowIso } from '../util/ids';
import { isInside, sanitizeFileName, uniquePath } from '../util/paths';
import type { DocumentDeps } from './document-model';

const MAX_IMPORT_BYTES = 500 * 1024 * 1024;
const NAME_ATTEMPTS = 5;
const ZIP_MAGIC = (b: Buffer) => b[0] === 0x50 && b[1] === 0x4b;
const JPEG_MAGIC = (b: Buffer) => b[0] === 0xff && b[1] === 0xd8;
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  pdf: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  docx: ZIP_MAGIC,
  pptx: ZIP_MAGIC,
  xlsx: ZIP_MAGIC,
  png: (b) => b[0] === 0x89 && b.subarray(1, 4).toString('latin1') === 'PNG',
  jpg: JPEG_MAGIC,
  jpeg: JPEG_MAGIC,
};

export interface ImportResult {
  imported: DocumentRecord[];
  duplicates: Array<{ path: string; existingDocumentId: string }>;
  rejected: Array<{ path: string; reason: string }>;
}

/** A file that passed the checks before it is copied. */
interface CheckedFile {
  real: string;
  ext: string;
  size: number;
}

interface ImportBatch {
  autoLlm: boolean;
  out: ImportResult;
}

/** User-visible reason shown on a quarantined document. */
const quarantineReason = (ext: string) => `Der Dateiinhalt passt nicht zur Endung „.${ext}“.`;

function importFailureReason(err: NodeJS.ErrnoException): string {
  if (err.code === 'ENOENT') return 'Datei nicht gefunden.';
  if (err.code === 'EACCES') return 'Keine Leseberechtigung.';
  return `Import fehlgeschlagen: ${err.message}`;
}

/** True when the first bytes match the extension (unknown extensions always pass). */
async function contentMatchesExtension(file: string, ext: string): Promise<boolean> {
  const check = MAGIC[ext];
  if (!check) return true;
  const handle = await fsp.open(file, 'r');
  try {
    const head = Buffer.alloc(16);
    await handle.read(head, 0, 16, 0);
    return check(head);
  } finally {
    await handle.close();
  }
}

/** Copies into `dir` under a free name, never overwriting. */
async function copyToFolder(target: { source: string; dir: string; fileName: string }): Promise<string> {
  for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt += 1) {
    const dest = await uniquePath(target.dir, target.fileName);
    try {
      await fsp.copyFile(target.source, dest, fs.constants.COPYFILE_EXCL);
      return dest;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw fsError('Kein freier Dateiname im Eingang gefunden.');
}

/** File uploads: copied into the safe inbox, checked, hashed and queued for analysis; the original stays unchanged. */
export class DocumentImporter {
  private readonly supported = new Set<string>(SUPPORTED_EXTENSIONS);

  constructor(private readonly deps: DocumentDeps) {}

  private get db() {
    return this.deps.ctx.database.db;
  }

  async importPaths(inputPaths: string[], opts: { allowLlm?: boolean } = {}): Promise<ImportResult> {
    const batch: ImportBatch = { autoLlm: opts.allowLlm ?? this.deps.privacy.mode() === 'auto', out: { imported: [], duplicates: [], rejected: [] } };
    for (const input of inputPaths) await this.importOne(input, batch);
    this.deps.ctx.events.changed('documents', 'status');
    return batch.out;
  }

  private async importOne(input: string, batch: ImportBatch): Promise<void> {
    const staging: { path: string | null } = { path: null };
    try {
      await this.stageAndRecord(input, { batch, staging });
    } catch (err) {
      if (staging.path) await fsp.unlink(staging.path).catch(() => undefined);
      const error = err as NodeJS.ErrnoException;
      this.deps.ctx.logger.error('documents', 'Import failed', { error: err, path: input });
      batch.out.rejected.push({ path: input, reason: importFailureReason(error) });
      this.deps.notifications.create({
        title: 'Dateiimport fehlgeschlagen',
        description: `${path.basename(input)}: ${error.message}`,
        type: 'import_failed',
        priority: 'normal',
        dedupeKey: `import-failed:${input}`,
      });
    }
  }

  /** `staging.path` holds our own inbox copy while it still has to be removed on failure. */
  private async stageAndRecord(input: string, state: { batch: ImportBatch; staging: { path: string | null } }): Promise<void> {
    const { out } = state.batch;
    const checked = await this.check(input);
    if ('reason' in checked) {
      out.rejected.push({ path: input, reason: checked.reason });
      return;
    }
    if (!(await contentMatchesExtension(checked.real, checked.ext))) {
      await this.quarantine(checked);
      out.rejected.push({ path: input, reason: 'Der Dateiinhalt passt nicht zur Endung – Kopie in die Quarantäne gelegt (Inbox, Filter „Quarantäne“).' });
      return;
    }
    const staged = await copyToFolder({ source: checked.real, dir: this.deps.ctx.paths.inbox, fileName: sanitizeFileName(path.basename(checked.real)) });
    state.staging.path = staged;
    const sha = await sha256File(staged);
    const duplicate = this.deps.documents.findDuplicates(sha)[0];
    if (duplicate) {
      await fsp.unlink(staged); // our own temporary copy
      state.staging.path = null;
      out.duplicates.push({ path: input, existingDocumentId: duplicate.id });
      this.notifyDuplicate(checked.real, duplicate);
      return;
    }
    const doc = this.deps.documents.insertDocument({
      originalName: path.basename(checked.real),
      ext: checked.ext,
      size: checked.size,
      sha256: sha,
      sourcePath: checked.real,
      stagedPath: staged,
      folderLlmAllowed: this.deps.documents.folderLlmAllowedFor(checked.real),
    });
    this.deps.audit.log({
      action: 'document.import',
      actor: 'user',
      trigger: 'upload',
      confirmed: true,
      entityIds: [doc.id],
      paths: [checked.real, staged],
      after: { sha256: sha, size: checked.size },
    });
    this.deps.jobs.enqueue('document.analyze', `Analysiere ${doc.originalName}`, { documentId: doc.id, allowLlm: state.batch.autoLlm });
    out.imported.push(doc);
    state.staging.path = null;
  }

  private async check(input: string): Promise<CheckedFile | { reason: string }> {
    if (!path.isAbsolute(input) || input.includes('\0')) return { reason: 'Ungültiger Dateipfad.' };
    const real = await fsp.realpath(input);
    const stat = await fsp.stat(real);
    if (!stat.isFile()) return { reason: 'Keine reguläre Datei (Ordner werden nicht direkt importiert).' };
    const ext = path.extname(real).slice(1).toLowerCase();
    if (!this.supported.has(ext)) return { reason: `Dateityp „.${ext || '?'}“ wird nicht unterstützt.` };
    if (stat.size > MAX_IMPORT_BYTES) return { reason: 'Datei ist zu groß (maximal 500 MB).' };
    if (stat.size === 0) return { reason: 'Die Datei ist leer.' };
    return { real, ext, size: stat.size };
  }

  private notifyDuplicate(real: string, duplicate: { id: string; title: string }): void {
    this.deps.notifications.create({
      title: 'Duplikat erkannt',
      description: `„${path.basename(real)}“ entspricht bereits dem Dokument „${duplicate.title}“ und wurde nicht erneut importiert.`,
      type: 'duplicate',
      priority: 'low',
      affectedEntityIds: [duplicate.id],
      proposedActions: [{ label: 'Dokument öffnen', kind: 'navigate', target: '/documents/' }],
    });
  }

  /** Records a copy of a file whose content does not match its extension as `quarantined` (once per content), unparsed. */
  private async quarantine(file: CheckedFile): Promise<void> {
    const sha = await sha256File(file.real);
    const existing = this.db
      .select()
      .from(documents)
      .where(and(eq(documents.sha256, sha), eq(documents.status, 'quarantined')))
      .all()
      .find((d) => d.stagedPath && fs.existsSync(d.stagedPath));
    if (existing) return;
    const copy = await copyToFolder({ source: file.real, dir: this.deps.ctx.paths.quarantine, fileName: sanitizeFileName(path.basename(file.real)) });
    const doc = this.deps.documents.insertDocument({
      originalName: path.basename(file.real),
      ext: file.ext,
      size: file.size,
      sha256: sha,
      sourcePath: file.real,
      stagedPath: copy,
      status: 'quarantined',
      processingError: quarantineReason(file.ext),
      folderLlmAllowed: this.deps.documents.folderLlmAllowedFor(file.real),
    });
    this.deps.audit.log({
      action: 'document.quarantine',
      actor: 'user',
      trigger: 'upload',
      confirmed: false,
      entityIds: [doc.id],
      paths: [file.real, copy],
      success: true,
    });
    this.deps.notifications.create({
      title: 'Datei in Quarantäne',
      description: `„${doc.originalName}“: ${quarantineReason(file.ext)} Die Datei wurde nicht importiert.`,
      type: 'import_failed',
      priority: 'normal',
      affectedEntityIds: [doc.id],
      proposedActions: [{ label: 'Inbox öffnen', kind: 'navigate', target: '/inbox/' }],
      dedupeKey: `quarantine:${doc.id}`,
    });
  }

  /** "Import anyway" (after the user's confirmation): moves a quarantined file into the inbox and queues it for analysis. */
  async releaseFromQuarantine(id: string): Promise<DocumentRecord> {
    const row = this.deps.documents.getRow(id);
    if (row.status !== 'quarantined') throw new AppError('validation_error', 'Das Dokument liegt nicht in der Quarantäne.');
    const file = row.stagedPath;
    if (!file || !isInside(this.deps.ctx.paths.quarantine, file) || !fs.existsSync(file))
      throw fsError('Die Datei in der Quarantäne ist nicht mehr vorhanden.', undefined, false);
    const sha = await sha256File(file);
    if (sha !== row.sha256) throw new AppError('validation_error', 'Die Datei in der Quarantäne wurde seither verändert und wird nicht importiert.');
    const duplicate = this.deps.documents.findDuplicates(sha, id)[0];
    if (duplicate) throw new AppError('validation_error', `Die Datei entspricht bereits dem Dokument „${duplicate.title}“.`);
    const staged = await copyToFolder({ source: file, dir: this.deps.ctx.paths.inbox, fileName: sanitizeFileName(row.originalName) });
    try {
      this.db
        .update(documents)
        .set({ status: 'staged', stagedPath: staged, processingStatus: 'pending', processingError: null, updatedAt: nowIso() })
        .where(eq(documents.id, id))
        .run();
    } catch (err) {
      await fsp.unlink(staged).catch(() => undefined);
      throw err;
    }
    await fsp.unlink(file).catch((err: unknown) => this.deps.ctx.logger.warn('documents', 'Quarantine copy not removed', { error: err, path: file }));
    this.deps.audit.log({
      action: 'document.releaseQuarantine',
      actor: 'user',
      trigger: 'manual',
      confirmed: true,
      entityIds: [id],
      paths: [file, staged],
      before: { status: 'quarantined' },
      after: { status: 'staged' },
    });
    this.deps.jobs.enqueue('document.analyze', `Analysiere ${row.originalName}`, { documentId: id, allowLlm: this.deps.privacy.mode() === 'auto' });
    this.deps.ctx.events.changed('documents', 'status');
    return this.deps.documents.get(id);
  }
}
