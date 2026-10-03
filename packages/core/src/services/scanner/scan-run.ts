import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ScanSummary } from '@archivist/shared';
import { and, eq, inArray, lt } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { scanExclusions, scanFiles, scanRoots } from '../../db/schema';
import { permissionError } from '../../util/errors';
import { nowIso } from '../../util/ids';
import { isForbiddenScanRoot, isInside } from '../../util/paths';
import type { WorkerPool } from '../../workers/pool';
import { SCAN_PAGE_SIZE, type ScanDirectoryInput, type ScanDirectoryResult } from '../../workers/tasks';
import type { DocumentService } from '../documents';
import { isJobCancelled, type JobContext } from '../jobs';
import type { NotificationService } from '../notifications';
import type { PrivacyService } from '../privacy';
import type { SettingsService } from '../settings';
import { PENDING_FILE_STATUSES, type FileRow, type RootRow } from './scan-files';
import { needsHash, ScanRecorder, scanResultsAction, type EntryOutcome } from './scan-record';

export interface ScanRunDeps {
  ctx: AppContext;
  settings: SettingsService;
  pool: WorkerPool;
  docs: DocumentService;
  privacy: PrivacyService;
  notifications: NotificationService;
  /** Files per walk page and batch (lowered in tests). */
  pageSize?: () => number;
}

type Exclusion = typeof scanExclusions.$inferSelect;

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

/** Directory scan of the approved roots: records new, changed and vanished files; never reads content for the LLM. */
export class ScanRun {
  private readonly recorder: ScanRecorder;

  constructor(private readonly deps: ScanRunDeps) {
    this.recorder = new ScanRecorder(deps);
  }

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
    const now = nowIso();
    const unreadable: string[] = [];
    let cursor: Pick<ScanDirectoryInput, 'after' | 'visited'> = {};
    do {
      job?.throwIfCancelled();
      const walked = await this.deps.pool.run('scanDirectory', this.walkInput(root, { realPath, exclusions: scope.exclusions, cursor }), { signal: job?.signal });
      if (summary.errors.length < 20) summary.errors.push(...walked.errors.slice(0, 20 - summary.errors.length));
      summary.skipped += walked.skipped.length;
      unreadable.push(...walked.unreadable);
      await this.scanBatch({ root, entries: walked.entries, summary, now, job });
      cursor = walked.nextCursor === null ? {} : { after: walked.nextCursor, visited: walked.visited };
    } while (cursor.after !== undefined);
    this.removeVanished({ root, now, unreadable });
    this.db.update(scanRoots).set({ lastScanAt: now, lastSummary: summary }).where(eq(scanRoots.id, root.id)).run();
    this.notifyScan(root, summary);
  }

  /** One page of walked files: the content of new or changed ones is read first, then all rows are written in one transaction. */
  private async scanBatch(batch: {
    root: RootRow;
    entries: ScanDirectoryResult['entries'];
    summary: ScanSummary;
    now: string;
    job?: JobContext;
  }): Promise<void> {
    const { root, entries, summary, now, job } = batch;
    if (entries.length === 0) return;
    const known = new Map(
      this.db
        .select()
        .from(scanFiles)
        .where(
          and(
            eq(scanFiles.rootId, root.id),
            inArray(
              scanFiles.path,
              entries.map((entry) => entry.path),
            ),
          ),
        )
        .all()
        .map((file) => [file.path, file]),
    );
    const outcomes = await Promise.all(
      entries.map(async (entry): Promise<EntryOutcome> => {
        const previous = known.get(entry.path);
        if (!needsHash(previous, entry)) return {};
        job?.throwIfCancelled();
        return this.readContent({ file: entry.path, previous, signal: job?.signal });
      }),
    );
    job?.throwIfCancelled();
    summary.scanned += entries.length;
    this.deps.ctx.database.transaction(() => {
      // every walked file counts as seen, whatever happens to it below: the rest of the root's rows are the vanished ones
      this.db
        .update(scanFiles)
        .set({ lastSeenAt: now })
        .where(
          and(
            eq(scanFiles.rootId, root.id),
            inArray(
              scanFiles.path,
              entries.map((entry) => entry.path),
            ),
          ),
        )
        .run();
      for (const [index, entry] of entries.entries()) this.recorder.apply({ root, entry, previous: known.get(entry.path), summary, now }, outcomes[index]!);
    });
  }

  private async readContent(scope: { file: string; previous: FileRow | undefined; signal?: AbortSignal }): Promise<EntryOutcome> {
    const { file, previous, signal } = scope;
    let sha: string;
    try {
      sha = await this.deps.pool.run('hashFile', { path: file }, { signal });
    } catch (err) {
      return { error: (err as Error).message };
    }
    const changedContent = previous?.documentId && previous.sha256 !== sha;
    return { sha, refreshed: previous && changedContent ? await this.recorder.refreshIndexedOnly(previous) : false };
  }

  private walkInput(
    root: RootRow,
    scope: { realPath: string; exclusions: Exclusion[]; cursor: Pick<ScanDirectoryInput, 'after' | 'visited'> },
  ): ScanDirectoryInput {
    const { realPath, exclusions, cursor } = scope;
    return {
      root: realPath,
      recursive: root.recursive,
      excludedDirs: [
        ...exclusions.filter((exclusion) => exclusion.kind === 'dir').map((exclusion) => exclusion.path),
        ...root.excludedSubdirs.map((dir) => (path.isAbsolute(dir) ? dir : path.join(realPath, dir))),
        this.deps.ctx.paths.root,
        this.deps.settings.get().archiveRoot,
      ],
      excludedFiles: exclusions.filter((exclusion) => exclusion.kind === 'file').map((exclusion) => exclusion.path),
      extensions: root.extensions,
      maxSizeBytes: root.maxFileSizeMb * 1024 * 1024,
      pageSize: this.deps.pageSize?.() ?? SCAN_PAGE_SIZE,
      ...cursor,
    };
  }

  /** Pending rows of the root not seen in this scan are vanished, unless they lie in an area that could not be read. */
  private removeVanished(scan: { root: RootRow; now: string; unreadable: string[] }): void {
    const { root, now, unreadable } = scan;
    const unseen = this.db
      .select({ id: scanFiles.id, path: scanFiles.path })
      .from(scanFiles)
      .where(and(eq(scanFiles.rootId, root.id), lt(scanFiles.lastSeenAt, now), inArray(scanFiles.status, PENDING_FILE_STATUSES)))
      .all();
    const vanished = unseen.filter((file) => !unreadable.some((area) => isInside(area, file.path))).map((file) => file.id);
    for (let start = 0; start < vanished.length; start += SCAN_PAGE_SIZE)
      this.db
        .delete(scanFiles)
        .where(inArray(scanFiles.id, vanished.slice(start, start + SCAN_PAGE_SIZE)))
        .run();
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
