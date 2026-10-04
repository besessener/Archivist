import path from 'node:path';
import type { ArchiveAllPreview, ArchiveAllSource, ArchiveItemRequest, ArchiveResult, Job } from '@archivist/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context';
import { documents } from '../db/schema';
import { permissionError, validationError } from '../util/errors';
import { progressLine } from '../util/bulk-text';
import { newId } from '../util/ids';
import { addOutcome, emptyArchiveResult, outcomeWithoutChange, type ExecuteOptions } from './archive-model';
import type { ArchiveService } from './archive';
import { isJobCancelled, type JobContext, type JobQueueService } from './jobs';
import type { NotificationService } from './notifications';

/** Job type of „Alle Vorschläge archivieren“. */
export const ARCHIVE_ALL_JOB = 'archive.all';

/** Documents per call of the archive service; each has its own audit entry, so a run can stop and be undone anywhere. */
export const ARCHIVE_BATCH_SIZE = 100;
const PREVIEW_FOLDERS = 20;
/** Previews kept for their confirmation; an older one has to be opened again. */
const KEPT_PREVIEWS = 5;
const CHANGED_SINCE_PREVIEW = 'Seit der Vorschau verändert – nicht archiviert.';
const PREVIEW_EXPIRED = 'Die Vorschau ist abgelaufen. Öffne „Alle Vorschläge archivieren“ erneut und prüfe sie noch einmal.';

export interface ArchiveAllPayload {
  source: ArchiveAllSource;
  /** Exactly the documents the confirmed preview showed. */
  documentIds: string[];
  approveNewCategories: string[];
}

interface ArchiveAllCheckpoint {
  next: number;
  success: number;
  skipped: number;
  failed: number;
  conflicts: number;
}

/** Archives the requests in batches (the one batch logic of the inbox, the scan proposals and the insights); `afterBatch` sees the progress. */
export async function archiveInBatches(
  archive: Pick<ArchiveService, 'execute'>,
  items: ArchiveItemRequest[],
  options: Pick<ExecuteOptions, 'approveNewCategories' | 'inboxCleanup'> & {
    trigger: string;
    from?: number;
    afterBatch?: (done: number, batch: ArchiveResult) => void;
  },
): Promise<ArchiveResult> {
  const result = emptyArchiveResult();
  for (let start = options.from ?? 0; start < items.length; start += ARCHIVE_BATCH_SIZE) {
    const chunk = items.slice(start, start + ARCHIVE_BATCH_SIZE);
    const batch = await archive.execute(chunk, {
      confirmed: true,
      approveNewCategories: options.approveNewCategories,
      confirmMove: chunk.some((item) => item.mode === 'move'),
      trigger: options.trigger,
      inboxCleanup: options.inboxCleanup,
    });
    for (const outcome of batch.items) addOutcome(result, outcome);
    options.afterBatch?.(Math.min(start + ARCHIVE_BATCH_SIZE, items.length), batch);
  }
  return result;
}

export interface ArchiveAllDeps {
  ctx: AppContext;
  archive: ArchiveService;
  jobs: JobQueueService;
  notifications: NotificationService;
  /** Documents of the scan's assignment groups. */
  scanDocumentIds: () => string[];
}

/** „Alle N Vorschläge archivieren“: every proposal becomes a copy in the archive, in one job; originals are never touched. */
export class ArchiveAll {
  private readonly previews = new Map<string, { source: ArchiveAllSource; documentIds: string[] }>();

  constructor(private readonly deps: ArchiveAllDeps) {}

  private get db() {
    return this.deps.ctx.database.db;
  }

  /** The documents with a proposal waiting for the user's decision, oldest first. */
  documentIds(source: ArchiveAllSource): string[] {
    const proposed = eq(documents.status, 'proposed');
    const scanIds = source === 'scan' ? this.deps.scanDocumentIds() : null;
    if (scanIds && scanIds.length === 0) return [];
    return this.db
      .select({ id: documents.id })
      .from(documents)
      .where(scanIds ? and(proposed, inArray(documents.id, scanIds)) : proposed)
      .orderBy(asc(documents.createdAt), asc(documents.id))
      .all()
      .map((row) => row.id);
  }

  private requests(ids: string[]): ArchiveItemRequest[] {
    return ids.map((documentId) => ({ documentId, mode: 'copy' }));
  }

  /** Plans every proposal without changing anything: the target structure the confirmation shows; the preview is kept for `enqueue`. */
  async preview(source: ArchiveAllSource): Promise<ArchiveAllPreview> {
    const ids = this.documentIds(source);
    const folders = new Map<string, number>();
    const newCategories = new Set<string>();
    const archivable: string[] = [];
    for (let start = 0; start < ids.length; start += ARCHIVE_BATCH_SIZE) {
      const plan = await this.deps.archive.preview(this.requests(ids.slice(start, start + ARCHIVE_BATCH_SIZE)));
      plan.newCategories.forEach((category) => newCategories.add(category));
      for (const item of plan.items) {
        if (item.blocked || !item.targetRelPath) continue;
        archivable.push(item.documentId);
        folders.set(path.posix.dirname(item.targetRelPath), (folders.get(path.posix.dirname(item.targetRelPath)) ?? 0) + 1);
      }
    }
    const largest = [...folders].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([folder, count]) => ({ path: folder, count }));
    return {
      previewId: this.keepPreview({ source, documentIds: archivable }),
      count: archivable.length,
      blocked: ids.length - archivable.length,
      folders: largest.slice(0, PREVIEW_FOLDERS),
      moreFolders: Math.max(0, largest.length - PREVIEW_FOLDERS),
      newCategories: [...newCategories].sort(),
    };
  }

  private keepPreview(preview: { source: ArchiveAllSource; documentIds: string[] }): string {
    const previewId = newId();
    this.previews.set(previewId, preview);
    for (const old of [...this.previews.keys()].slice(0, Math.max(0, this.previews.size - KEPT_PREVIEWS))) this.previews.delete(old);
    return previewId;
  }

  /** Level 2: queues the job over exactly the documents of the confirmed preview; new main categories are created only as far as approved. */
  enqueue(request: { previewId: string; confirmed: boolean; approveNewCategories: string[] }): Job {
    if (!request.confirmed) throw permissionError('Das Archivieren aller Vorschläge erfordert eine ausdrückliche Bestätigung des Benutzers.');
    const preview = this.previews.get(request.previewId);
    if (!preview) throw validationError(PREVIEW_EXPIRED);
    const { source, documentIds } = preview;
    const payload: ArchiveAllPayload = { source, documentIds, approveNewCategories: request.approveNewCategories };
    return this.deps.jobs.enqueue(ARCHIVE_ALL_JOB, {
      label: `Archiviere ${documentIds.length} Vorschläge`,
      payload,
      sameAs: (active: ArchiveAllPayload) => active.source === source && sameIds(active.documentIds, documentIds),
      maxAttempts: 1,
    });
  }

  async run(job: JobContext<ArchiveAllPayload>): Promise<{ summary: string }> {
    const { documentIds, approveNewCategories } = job.payload;
    const saved = (job.checkpoint ?? {}) as Partial<ArchiveAllCheckpoint>;
    const state: ArchiveAllCheckpoint = { next: 0, success: 0, skipped: 0, failed: 0, conflicts: 0, ...saved };
    const started = Date.now();
    const resumedAt = state.next;
    try {
      await archiveInBatches(this.stillProposed(), this.requests(documentIds), {
        approveNewCategories,
        trigger: 'manual',
        inboxCleanup: 'later',
        from: state.next,
        afterBatch: (done, batch) => {
          Object.assign(state, { next: done, success: state.success + batch.success, skipped: state.skipped + batch.skipped });
          Object.assign(state, { failed: state.failed + batch.failed, conflicts: state.conflicts + batch.conflicts });
          job.saveCheckpoint(state);
          job.throwIfCancelled();
          job.report(
            done / documentIds.length,
            progressLine({ done, total: documentIds.length, elapsedMs: Date.now() - started, sampled: done - resumedAt, verb: 'archiviert' }),
          );
        },
      });
    } catch (err) {
      if (isJobCancelled(err)) this.announce(state, 'Archivierung abgebrochen');
      throw err;
    } finally {
      await this.deps.archive.cleanupInbox();
    }
    return { summary: this.announce(state, 'Archivierung abgeschlossen') };
  }

  /** The archive service, but documents that are no longer proposals since the preview are skipped instead of archived. */
  private stillProposed(): Pick<ArchiveService, 'execute'> {
    return {
      execute: async (items, options) => {
        const ids = items.map((item) => item.documentId);
        const proposed = new Set(
          this.db
            .select({ id: documents.id })
            .from(documents)
            .where(and(inArray(documents.id, ids), eq(documents.status, 'proposed')))
            .all()
            .map((row) => row.id),
        );
        const current = items.filter((item) => proposed.has(item.documentId));
        const result = current.length > 0 ? await this.deps.archive.execute(current, options) : emptyArchiveResult();
        for (const id of ids.filter((documentId) => !proposed.has(documentId)))
          addOutcome(result, outcomeWithoutChange({ documentId: id, outcome: 'skipped', message: CHANGED_SINCE_PREVIEW }));
        return result;
      },
    };
  }

  private announce(state: ArchiveAllCheckpoint, title: string): string {
    const summary = `${state.success} archiviert, ${state.skipped} übersprungen, ${state.failed} fehlgeschlagen, ${state.conflicts} Konflikte.`;
    this.deps.notifications.create({
      title,
      description: `${summary} Die Originale wurden nicht verändert; jeden Eintrag kannst du im Protokoll rückgängig machen.`,
      type: 'system',
      priority: state.failed + state.conflicts > 0 ? 'normal' : 'low',
      proposedActions: [{ label: 'Dokumente öffnen', kind: 'navigate', target: '/documents/' }],
    });
    return summary;
  }
}

const sameIds = (a: string[], b: string[]): boolean => a.length === b.length && a.every((id, index) => id === b[index]);
