import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ScanFileStatus, ScanSummary } from '@archivist/shared';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { scanExclusions, scanFiles, scanRoots } from '../../db/schema';
import { MIME_BY_EXT } from '../../parsers';
import { permissionError } from '../../util/errors';
import { newId, nowIso } from '../../util/ids';
import { isForbiddenScanRoot, isInside } from '../../util/paths';
import type { WorkerPool } from '../../workers/pool';
import type { ScanDirectoryInput, ScanDirectoryResult, ScanEntry } from '../../workers/tasks';
import type { DocumentService } from '../documents';
import { isJobCancelled, type JobContext } from '../jobs';
import type { NotificationService } from '../notifications';
import type { PrivacyService } from '../privacy';
import type { SettingsService } from '../settings';
import { duplicateOf, PENDING_FILE_STATUSES, type FileRow, type RootRow } from './scan-files';

export interface ScanRunDeps {
  ctx: AppContext;
  settings: SettingsService;
  pool: WorkerPool;
  docs: DocumentService;
  privacy: PrivacyService;
  notifications: NotificationService;
  /** Upper bound of files collected per scan root (the scanner's setting, lowered in tests). */
  maxFilesPerRoot: () => number;
}

type Exclusion = typeof scanExclusions.$inferSelect;

/** One walked file of a scan root, with what the scan knew about it before. */
interface EntryScope {
  root: RootRow;
  entry: ScanEntry;
  previous: FileRow | undefined;
  summary: ScanSummary;
  now: string;
}

const emptySummary = (rootId: string): ScanSummary => ({
  rootId,
  scanned: 0,
  newFiles: 0,
  changedFiles: 0,
  unchanged: 0,
  excluded: 0,
  skipped: 0,
  duplicates: 0,
  errors: [],
});

const scanResultsAction = () => ({ label: 'Scan-Ergebnisse prüfen', kind: 'navigate' as const, target: '/scan/' });

/** Directory scan of the approved roots: records new, changed and vanished files; never reads content for the LLM. */
export class ScanRun {
  constructor(private readonly deps: ScanRunDeps) {}

  private get db() {
    return this.deps.ctx.database.db;
  }

  async run(rootId: string | null, job?: JobContext): Promise<ScanSummary[]> {
    const roots = this.db
      .select()
      .from(scanRoots)
      .where(rootId ? eq(scanRoots.id, rootId) : eq(scanRoots.enabled, true))
      .all();
    const exclusions = this.db.select().from(scanExclusions).all();
    const summaries: ScanSummary[] = [];
    for (const [index, root] of roots.entries()) {
      job?.throwIfCancelled();
      const summary = emptySummary(root.id);
      try {
        await this.scanRoot({ root, exclusions, summary, job, progress: index / roots.length });
      } catch (err) {
        if (isJobCancelled(err)) throw err; // cancelled or interrupted on quit – no scan error
        summary.errors.push(err instanceof Error ? err.message : String(err));
        this.deps.ctx.logger.error('scanner', 'Scan failed', { root: root.path, error: err });
        this.deps.notifications.create({
          title: 'Scan teilweise fehlgeschlagen',
          description: `${root.path}: ${summary.errors[summary.errors.length - 1]}`,
          type: 'scan_partial',
          priority: 'high',
          proposedActions: [{ label: 'Scan-Verzeichnis verwalten', kind: 'navigate', target: '/scan/' }],
        });
      }
      summaries.push(summary);
    }
    this.deps.ctx.events.changed('scanner', 'status');
    return summaries;
  }

  private async scanRoot(scope: { root: RootRow; exclusions: Exclusion[]; summary: ScanSummary; job?: JobContext; progress: number }): Promise<void> {
    const { root, summary, job } = scope;
    const realPath = await fsp.realpath(root.path); // the directory may have been removed/replaced in the meantime
    if (isForbiddenScanRoot(realPath)) throw permissionError('Verzeichnis ist nicht (mehr) für Scans zulässig.', realPath);
    job?.report(scope.progress, `Durchsuche ${root.path}`);
    const walked = await this.deps.pool.run('scanDirectory', this.walkInput(root, { realPath, exclusions: scope.exclusions }));
    summary.errors.push(...walked.errors.slice(0, 20));
    summary.skipped = walked.skipped.length;
    if (walked.limitReached) summary.limitReached = true;
    const known = new Map(
      this.db
        .select()
        .from(scanFiles)
        .where(eq(scanFiles.rootId, root.id))
        .all()
        .map((file) => [file.path, file]),
    );
    const now = nowIso();
    for (const entry of walked.entries) {
      job?.throwIfCancelled();
      summary.scanned += 1;
      await this.scanEntry({ root, entry, previous: known.get(entry.path), summary, now });
    }
    // beyond the file limit or in an unreadable area a file was merely not seen: it does not count as vanished
    if (!walked.limitReached) this.removeVanished(known, walked);
    this.db.update(scanRoots).set({ lastScanAt: now, lastSummary: summary }).where(eq(scanRoots.id, root.id)).run();
    this.notifyScan(root, summary);
  }

  private walkInput(root: RootRow, scope: { realPath: string; exclusions: Exclusion[] }): ScanDirectoryInput {
    const { realPath, exclusions } = scope;
    return {
      root: realPath,
      recursive: root.recursive,
      excludedDirs: [
        ...exclusions.filter((exclusion) => exclusion.kind === 'dir').map((exclusion) => exclusion.path),
        ...root.excludedSubdirs.map((dir) => (path.isAbsolute(dir) ? dir : path.join(realPath, dir))),
        this.deps.ctx.paths.root,
        this.deps.ctx.paths.appData,
        this.deps.settings.get().archiveRoot,
      ],
      excludedFiles: exclusions.filter((exclusion) => exclusion.kind === 'file').map((exclusion) => exclusion.path),
      extensions: root.extensions,
      maxSizeBytes: root.maxFileSizeMb * 1024 * 1024,
      maxFiles: this.deps.maxFilesPerRoot(),
    };
  }

  /** Removes vanished, not yet processed files from the list. */
  private removeVanished(known: Map<string, FileRow>, walked: ScanDirectoryResult): void {
    const seen = new Set(walked.entries.map((entry) => entry.path));
    for (const [filePath, file] of known) {
      const pending = PENDING_FILE_STATUSES.includes(file.status as ScanFileStatus);
      if (!seen.has(filePath) && pending && !walked.unreadable.some((unreadable) => isInside(unreadable, filePath)))
        this.db.delete(scanFiles).where(eq(scanFiles.id, file.id)).run();
    }
  }

  /** Re-evaluates the duplicate state of a not yet processed file whose content did not change. */
  private recheckDuplicate(previous: FileRow): Pick<FileRow, 'status' | 'duplicateOfDocumentId'> | null {
    if (!previous.sha256 || !PENDING_FILE_STATUSES.includes(previous.status as ScanFileStatus)) return null;
    const duplicate = duplicateOf(this.deps.docs, { sha256: previous.sha256, documentId: previous.documentId });
    if (duplicate)
      return duplicate === previous.duplicateOfDocumentId && previous.status === 'duplicate' ? null : { status: 'duplicate', duplicateOfDocumentId: duplicate };
    // the document it duplicated is gone (ignored, deleted): the file is open again
    return previous.status === 'duplicate' ? { status: 'new', duplicateOfDocumentId: null } : null;
  }

  /** Content of a known file is unchanged: refresh it (and its duplicate state) without touching its status otherwise. */
  private markUnchanged(file: { previous: FileRow; summary: ScanSummary }, set: Partial<FileRow>): void {
    const duplicate = this.recheckDuplicate(file.previous);
    this.db
      .update(scanFiles)
      .set({ ...set, ...duplicate })
      .where(eq(scanFiles.id, file.previous.id))
      .run();
    if (duplicate?.status === 'duplicate') file.summary.duplicates += 1;
    file.summary.unchanged += 1;
  }

  /** The original of an index-only document changed: re-read it in place, the scan file keeps its status (#229). */
  private async refreshIndexedOnly(file: { previous: FileRow; entry: ScanEntry; sha: string; now: string }): Promise<boolean> {
    const { previous, entry, sha, now } = file;
    const doc = this.deps.docs.findRow(previous.documentId!);
    if (doc?.status !== 'indexed_only') return false;
    try {
      await this.deps.docs.refreshIndexedOnly(doc.id);
    } catch (err) {
      this.deps.ctx.logger.warn('scanner', 'Index-only document not refreshed', { documentId: doc.id, error: err });
      return false;
    }
    this.db.update(scanFiles).set({ size: entry.size, mtimeMs: entry.mtimeMs, sha256: sha, lastSeenAt: now }).where(eq(scanFiles.id, previous.id)).run();
    return true;
  }

  /** Records one walked file: unchanged files are only refreshed, new or changed ones are hashed and checked for duplicates. */
  private async scanEntry(scope: EntryScope): Promise<void> {
    const { entry, previous, summary, now } = scope;
    if (previous?.status === 'excluded') {
      summary.excluded += 1;
      return;
    }
    // known and unchanged → do not hash/analyze again
    if (previous && previous.size === entry.size && previous.mtimeMs === entry.mtimeMs) {
      this.markUnchanged({ previous, summary }, { lastSeenAt: now });
      return;
    }
    let sha: string;
    try {
      sha = await this.deps.pool.run('hashFile', { path: entry.path });
    } catch (err) {
      summary.errors.push(`${entry.path}: ${(err as Error).message}`);
      return;
    }
    if (previous && previous.sha256 === sha) {
      // only the timestamp changed (touched, or restored by an undo): same content, the status stays
      this.markUnchanged({ previous, summary }, { size: entry.size, mtimeMs: entry.mtimeMs, lastSeenAt: now });
      return;
    }
    if (previous?.documentId && (await this.refreshIndexedOnly({ previous, entry, sha, now }))) {
      summary.changedFiles += 1;
      return;
    }
    this.recordContent({ ...scope, sha });
  }

  /** New or changed content: privacy status and duplicate state are evaluated afresh. */
  private recordContent(scope: EntryScope & { sha: string }): void {
    const { root, entry, previous, summary } = scope;
    const decision = this.deps.privacy.evaluate({ path: entry.path, ext: entry.ext, rootLlmAllowed: root.llmAllowed });
    const llmStatus = decision.allowed ? 'local_only' : (decision.status ?? 'local_only');
    const duplicate = duplicateOf(this.deps.docs, { sha256: scope.sha, documentId: previous?.documentId });
    if (previous) this.recordChanged({ ...scope, previous }, { llmStatus, duplicate });
    else this.recordNew(scope, { llmStatus, duplicate });
    if (duplicate) summary.duplicates += 1;
  }

  private recordChanged(scope: EntryScope & { sha: string; previous: FileRow }, state: { llmStatus: string; duplicate: string | null }): void {
    const { entry, previous, sha, now } = scope;
    const wasArchived = previous.status === 'archived' || previous.status === 'analyzed';
    const status: ScanFileStatus = state.duplicate ? 'duplicate' : 'changed';
    this.db
      .update(scanFiles)
      .set({
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        sha256: sha,
        status,
        llmStatus: state.llmStatus,
        duplicateOfDocumentId: state.duplicate,
        lastSeenAt: now,
      })
      .where(eq(scanFiles.id, previous.id))
      .run();
    scope.summary.changedFiles += 1;
    if (!wasArchived) return;
    this.deps.notifications.create({
      title: 'Datei seit Archivierung verändert',
      description: `„${entry.name}“ in ${path.dirname(entry.path)} wurde nach der Archivierung geändert.`,
      type: 'file_changed',
      priority: 'normal',
      affectedEntityIds: previous.documentId ? [previous.documentId] : [],
      proposedActions: [scanResultsAction()],
      dedupeKey: `file-changed:${previous.id}:${sha}`,
    });
  }

  private recordNew(scope: EntryScope & { sha: string }, state: { llmStatus: string; duplicate: string | null }): void {
    const { root, entry, sha, now } = scope;
    this.db
      .insert(scanFiles)
      .values({
        id: newId(),
        rootId: root.id,
        path: entry.path,
        name: entry.name,
        ext: entry.ext,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        sha256: sha,
        mime: MIME_BY_EXT[entry.ext] ?? entry.mime,
        status: state.duplicate ? 'duplicate' : 'new',
        llmStatus: state.llmStatus,
        documentId: null,
        duplicateOfDocumentId: state.duplicate,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .run();
    scope.summary.newFiles += 1;
  }

  private notifyScan(root: RootRow, summary: ScanSummary): void {
    const folder = path.basename(root.path);
    const fresh = summary.newFiles + summary.changedFiles;
    if (fresh > 0) {
      this.deps.notifications.create({
        title: `${fresh} neue oder geänderte Dokumente gefunden`,
        description: `${folder}: ${summary.newFiles} neu, ${summary.changedFiles} geändert, ${summary.duplicates} mögliche Duplikate, ${summary.unchanged} unverändert übersprungen.`,
        type: 'scan_new_files',
        priority: 'normal',
        proposedActions: [scanResultsAction()],
        dedupeKey: `scan-new:${root.id}:${summary.scanned}:${fresh}:${summary.duplicates}`,
      });
    }
    if (summary.limitReached) {
      this.deps.notifications.create({
        title: 'Scan-Limit erreicht',
        description: `${folder}: Es wurden nur die ersten ${this.deps.maxFilesPerRoot().toLocaleString('de-DE')} passenden Dateien geprüft; weitere Dateien wurden nicht erfasst. Bitte Unterordner ausschließen oder kleinere Verzeichnisse einzeln freigeben.`,
        type: 'scan_partial',
        priority: 'normal',
        proposedActions: [{ label: 'Scan-Verzeichnis verwalten', kind: 'navigate', target: '/scan/' }],
        dedupeKey: `scan-limit:${root.id}`,
      });
    }
    if (summary.duplicates > 0) {
      this.deps.notifications.create({
        title: `${summary.duplicates} Datei(en) entsprechen bereits vorhandenen Dokumenten`,
        description: `In ${folder} liegen mögliche externe Duplikate.`,
        type: 'external_duplicate',
        priority: 'low',
        proposedActions: [scanResultsAction()],
        dedupeKey: `scan-dup:${root.id}:${summary.duplicates}:${summary.scanned}`,
      });
    }
    const failed = summary.errors.length > 0;
    this.deps.notifications.create({
      title: failed ? 'Scan teilweise fehlgeschlagen' : 'Scan abgeschlossen',
      description: `${folder}: ${summary.scanned} Dateien geprüft, ${summary.unchanged} unverändert übersprungen${failed ? `, ${summary.errors.length} Fehler` : ''}.`,
      type: failed ? 'scan_partial' : 'scan_done',
      priority: failed ? 'high' : 'low',
      proposedActions: [scanResultsAction()],
      dedupeKey: `scan-done:${root.id}:${Date.now()}`,
    });
  }
}
