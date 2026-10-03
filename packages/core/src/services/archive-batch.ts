import path from 'node:path';
import type { ArchiveAllPreview, ArchiveAllSource, ArchiveItemRequest, ArchiveResult, Job } from '@archivist/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context';
import { documents } from '../db/schema';
import { permissionError } from '../util/errors';
import { progressLine } from '../util/bulk-text';
import { addOutcome, emptyArchiveResult } from './archive-model';
import type { ArchiveService } from './archive';
import type { JobContext, JobQueueService } from './jobs';
import type { NotificationService } from './notifications';

/** Job type of „Alle Vorschläge archivieren“. */
export const ARCHIVE_ALL_JOB = 'archive.all';

/** Documents per call of the archive service; each has its own audit entry, so a run can stop and be undone anywhere. */
export const ARCHIVE_BATCH_SIZE = 100;
const PREVIEW_FOLDERS = 20;

export interface ArchiveAllPayload {
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
  options: { approveNewCategories: string[]; trigger: string; from?: number; afterBatch?: (done: number, batch: ArchiveResult) => void },
): Promise<ArchiveResult> {
  const result = emptyArchiveResult();
  for (let start = options.from ?? 0; start < items.length; start += ARCHIVE_BATCH_SIZE) {
    const chunk = items.slice(start, start + ARCHIVE_BATCH_SIZE);
    const batch = await archive.execute(chunk, {
      confirmed: true,
      approveNewCategories: options.approveNewCategories,
      confirmMove: chunk.some((item) => item.mode === 'move'),
      trigger: options.trigger,
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

  /** Plans every proposal without changing anything: the target structure the confirmation shows. */
  async preview(source: ArchiveAllSource): Promise<ArchiveAllPreview> {
    const ids = this.documentIds(source);
    const folders = new Map<string, number>();
    const newCategories = new Set<string>();
    let blocked = 0;
    for (let start = 0; start < ids.length; start += ARCHIVE_BATCH_SIZE) {
      const plan = await this.deps.archive.preview(this.requests(ids.slice(start, start + ARCHIVE_BATCH_SIZE)));
      plan.newCategories.forEach((category) => newCategories.add(category));
      for (const item of plan.items) {
        if (item.blocked || !item.targetRelPath) blocked += 1;
        else folders.set(path.posix.dirname(item.targetRelPath), (folders.get(path.posix.dirname(item.targetRelPath)) ?? 0) + 1);
      }
    }
    const largest = [...folders].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([folder, count]) => ({ path: folder, count }));
    return {
      count: ids.length - blocked,
      blocked,
      folders: largest.slice(0, PREVIEW_FOLDERS),
      moreFolders: Math.max(0, largest.length - PREVIEW_FOLDERS),
      newCategories: [...newCategories].sort(),
    };
  }

  /** Level 2: queues the job over the proposals that wait now (frozen here, like the consent). */
  enqueue(request: { source: ArchiveAllSource; confirmed: boolean; approveNewCategories: string[] }): Job {
    if (!request.confirmed) throw permissionError('Das Archivieren aller Vorschläge erfordert eine ausdrückliche Bestätigung des Benutzers.');
    const documentIds = this.documentIds(request.source);
    const payload: ArchiveAllPayload = { documentIds, approveNewCategories: request.approveNewCategories };
    return this.deps.jobs.enqueue(ARCHIVE_ALL_JOB, { label: `Archiviere ${documentIds.length} Vorschläge`, payload, sameAs: () => true, maxAttempts: 1 });
  }

  async run(job: JobContext<ArchiveAllPayload>): Promise<{ summary: string }> {
    const { documentIds, approveNewCategories } = job.payload;
    const saved = (job.checkpoint ?? {}) as Partial<ArchiveAllCheckpoint>;
    const state: ArchiveAllCheckpoint = { next: 0, success: 0, skipped: 0, failed: 0, conflicts: 0, ...saved };
    const started = Date.now();
    const resumedAt = state.next;
    await archiveInBatches(this.deps.archive, this.requests(documentIds), {
      approveNewCategories,
      trigger: 'manual',
      from: state.next,
      afterBatch: (done, batch) => {
        job.throwIfCancelled();
        Object.assign(state, { next: done, success: state.success + batch.success, skipped: state.skipped + batch.skipped });
        Object.assign(state, { failed: state.failed + batch.failed, conflicts: state.conflicts + batch.conflicts });
        job.saveCheckpoint(state);
        job.report(
          done / documentIds.length,
          progressLine({ done, total: documentIds.length, elapsedMs: Date.now() - started, sampled: done - resumedAt, verb: 'archiviert' }),
        );
      },
    });
    return { summary: this.announce(state) };
  }

  private announce(state: ArchiveAllCheckpoint): string {
    const summary = `${state.success} archiviert, ${state.skipped} übersprungen, ${state.failed} fehlgeschlagen, ${state.conflicts} Konflikte.`;
    this.deps.notifications.create({
      title: 'Archivierung abgeschlossen',
      description: `${summary} Die Originale wurden nicht verändert; jeden Eintrag kannst du im Protokoll rückgängig machen.`,
      type: 'system',
      priority: state.failed + state.conflicts > 0 ? 'normal' : 'low',
      proposedActions: [{ label: 'Dokumente öffnen', kind: 'navigate', target: '/documents/' }],
    });
    return summary;
  }
}
