import type { ArchiveItemRequest, ArchivePlan, ArchiveResult, VerifyReport } from '@archivist/shared';
import { permissionError, toErrorInfo } from '../util/errors';
import { ArchiveExecutor } from './archive-execute';
import { ExtractedItemProposer, type ProposalSink } from './archive-extracted-items';
import { ArchiveFileOps } from './archive-files';
import { ArchiveLocks } from './archive-locks';
import { ArchiveMaintenance, FOLDERS_RESTORE_UNDO } from './archive-maintenance';
import {
  addOutcome,
  emptyArchiveResult,
  failureMessage,
  type ArchiveOutcome,
  type ArchiveUndoData,
  type ExecuteOptions,
  type RelocatePlanItem,
  type RelocateRequest,
  type RelocateUndoData,
  type RenamePlanItem,
  type RenameRequest,
  type RenameUndoData,
} from './archive-model';
import { ArchivePlanner } from './archive-plan';
import { ArchiveRelocator } from './archive-relocate';
import { RelocateUndo } from './archive-relocate-undo';
import { ArchiveRenamer } from './archive-rename';
import { ArchiveUndo } from './archive-undo';
import type { OpenItemService } from './open-items';
import type { UndoService } from './undo';
import type { ArchiveDeps } from './archive-deps';

export type { RelocateRequest, RenameRequest } from './archive-model';

const UNCONFIRMED = 'Dateiaktionen erfordern eine ausdrückliche Bestätigung des Benutzers.';

export type ArchiveServiceDeps = Omit<ArchiveDeps, 'locks' | 'files'> & { undo: UndoService };

/** Controlled file actions: only with `confirmed`, never overwriting, verified before sources go, inside the archive, undo checks first. */
export class ArchiveService {
  private readonly deps: ArchiveDeps;
  private readonly extractedItems: ExtractedItemProposer;
  private readonly planner: ArchivePlanner;
  private readonly executor: ArchiveExecutor;
  private readonly relocator: ArchiveRelocator;
  private readonly renamer: ArchiveRenamer;
  private readonly maintenance: ArchiveMaintenance;

  constructor({ undo, ...services }: ArchiveServiceDeps) {
    this.deps = { ...services, locks: new ArchiveLocks(), files: new ArchiveFileOps(services.ctx) };
    this.extractedItems = new ExtractedItemProposer(services.notifications);
    this.planner = new ArchivePlanner(this.deps);
    this.executor = new ArchiveExecutor(this.deps, { planner: this.planner, extractedItems: this.extractedItems });
    this.relocator = new ArchiveRelocator(this.deps, (documentId, warnings) => this.executor.reindexAfterCommit(documentId, warnings));
    this.renamer = new ArchiveRenamer(this.deps);
    this.maintenance = new ArchiveMaintenance(this.deps);
    services.docs.useFileLock(this.deps.locks);
    this.registerUndo(undo);
  }

  private registerUndo(undo: UndoService): void {
    const { locks } = this.deps;
    const archiveUndo = new ArchiveUndo(this.deps);
    const relocateUndo = new RelocateUndo(this.deps);
    undo.register('archive_file', {
      check: (d) => archiveUndo.check(d as ArchiveUndoData),
      run: (d) => locks.guarded(() => archiveUndo.run(d as ArchiveUndoData)),
    });
    undo.register('archive_rename', {
      check: (d) => this.renamer.undoCheck(d as RenameUndoData),
      run: (d) => locks.guarded(() => this.renamer.undoRun(d as RenameUndoData)),
    });
    undo.register('archive_relocate', {
      check: (d) => relocateUndo.check(d as RelocateUndoData),
      run: (d) => locks.guarded(() => relocateUndo.run(d as RelocateUndoData)),
    });
    // removed empty folders come back as (still empty) folders; main categories are never removed
    undo.register(FOLDERS_RESTORE_UNDO, {
      check: async () => [],
      run: async (d) => {
        const { paths } = d as { paths: string[] };
        for (const p of paths) this.deps.categories.create(p, { confirmed: true });
        return `${paths.length} Ordner wiederhergestellt.`;
      },
    });
  }

  wire(deps: { actions: ProposalSink; openItems: OpenItemService }): void {
    this.extractedItems.wire(deps);
  }

  /** Blocks archive file operations while the archive root is changed; returns the function that lifts the block. */
  beginRootChange(): () => void {
    return this.deps.locks.beginRootChange();
  }

  /** Blocks archive file operations and root changes while a full backup copies the archive; returns the release function. */
  beginBackup(): () => void {
    return this.deps.locks.beginBackup();
  }

  /** For quitting: refuses new file operations and waits for the running ones; false when some are still running. */
  drain(timeoutMs: number): Promise<boolean> {
    return this.deps.locks.drain(timeoutMs);
  }

  isRootChangeActive(): boolean {
    return this.deps.locks.isRootChangeActive();
  }

  createCategory(p: string, { confirmed }: { confirmed: boolean }) {
    const category = this.deps.categories.create(p, { confirmed });
    this.deps.audit.log({ action: 'category.create', actor: 'user', trigger: 'manual', confirmed, after: { path: category.path } });
    return category;
  }

  preview(items: ArchiveItemRequest[]): Promise<ArchivePlan> {
    return this.planner.preview(items);
  }

  async execute(items: ArchiveItemRequest[], opts: ExecuteOptions): Promise<ArchiveResult> {
    if (!opts.confirmed) throw permissionError(UNCONFIRMED);
    return this.deps.locks.guarded(() => this.executeAll(items, opts));
  }

  private async executeAll(items: ArchiveItemRequest[], opts: ExecuteOptions): Promise<ArchiveResult> {
    await this.maintenance.cleanupInbox();
    const result = emptyArchiveResult();
    for (const req of items) {
      let outcome: ArchiveOutcome;
      try {
        outcome = await this.deps.locks.onePerDocument(req.documentId, () => this.executor.executeOne(req, opts));
      } catch (err) {
        this.deps.ctx.logger.error('archive', 'Archiving failed', { documentId: req.documentId, error: err });
        outcome = this.failed(err, { action: `archive.${req.mode}`, documentId: req.documentId, trigger: opts.trigger });
        this.deps.notifications.create({
          title: 'Archivierung fehlgeschlagen',
          description: outcome.message,
          type: 'import_failed',
          priority: 'high',
          affectedEntityIds: [req.documentId],
        });
      }
      addOutcome(result, outcome);
    }
    this.deps.ctx.events.changed('documents', 'knowledge', 'audit', 'status');
    return result;
  }

  /** Logs a failed file operation and returns its outcome. */
  private failed(err: unknown, attempt: { action: string; documentId: string; trigger: string | undefined }): ArchiveOutcome {
    const info = toErrorInfo(err);
    this.deps.audit.log({
      action: attempt.action,
      actor: 'user',
      trigger: attempt.trigger ?? 'manual',
      confirmed: true,
      entityIds: [attempt.documentId],
      success: false,
      error: `${info.message} ${info.details ?? ''}`.trim(),
    });
    return { documentId: attempt.documentId, outcome: 'failed', targetPath: null, message: failureMessage(err), auditId: null };
  }

  /** Removes inbox copies whose removal failed right after archiving; never throws, returns the number cleaned up. */
  cleanupInbox(): Promise<number> {
    return this.maintenance.cleanupInbox();
  }

  /** Preview (changes nothing): what would relocating do? */
  previewRelocate(items: RelocateRequest[]): Promise<RelocatePlanItem[]> {
    return this.relocator.preview(items);
  }

  /** Moves already archived documents into other archive folders. Requires explicit confirmation. */
  async relocate(items: RelocateRequest[], opts: { confirmed: boolean; trigger?: string }): Promise<ArchiveResult> {
    if (!opts.confirmed) throw permissionError(UNCONFIRMED);
    return this.deps.locks.guarded(() => this.relocateAll(items, opts.trigger));
  }

  private async relocateAll(items: RelocateRequest[], trigger: string | undefined): Promise<ArchiveResult> {
    const result = emptyArchiveResult();
    for (const req of items) {
      let outcome: ArchiveOutcome;
      try {
        outcome = await this.deps.locks.onePerDocument(req.documentId, () => this.relocator.relocateOne(req, trigger ?? 'manual'));
      } catch (err) {
        this.deps.ctx.logger.error('archive', 'Relocating failed', { documentId: req.documentId, error: err });
        outcome = this.failed(err, { action: 'archive.relocate', documentId: req.documentId, trigger });
      }
      addOutcome(result, outcome);
    }
    this.deps.ctx.events.changed('documents', 'knowledge', 'audit', 'status');
    return result;
  }

  /** Preview of renames: target names, conflicts with existing files and among each other – changes nothing. */
  async previewRename(items: RenameRequest[]): Promise<RenamePlanItem[]> {
    return this.renamer.previewRename(items);
  }

  /** Renames archived files within their folder; never overwrites, checks the checksum, logged with undo. */
  async rename(items: RenameRequest[], opts: { confirmed: boolean; trigger?: string }): Promise<ArchiveResult> {
    if (!opts.confirmed) throw permissionError(UNCONFIRMED);
    return this.deps.locks.guarded(async () => {
      const plan = this.renamer.previewRename(items);
      const result = emptyArchiveResult();
      for (const item of plan) addOutcome(result, await this.renamer.renameOne(item, opts.trigger));
      this.deps.ctx.events.changed('documents', 'audit', 'knowledge');
      return result;
    });
  }

  /** Removes empty folders of the archive (no file, no document) and their category entries; returns the removed paths. */
  removeEmptyFolders(): Promise<string[]> {
    return this.deps.locks.guarded(() => this.maintenance.removeEmptyFolders());
  }

  /** Compares the database and file system state of the archive. */
  verify(): Promise<VerifyReport> {
    return this.maintenance.verify();
  }
}
