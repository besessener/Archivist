import path from 'node:path';
import type { ArchiveRootChangeMode, ArchiveRootChangeResult, ArchiveRootPresence, ArchiveRootPreview, ArchiveRootStatus } from '@archivist/shared';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { AppContext } from '../context';
import { auditLog, documents } from '../db/schema';
import { AppError, permissionError, validationError } from '../util/errors';
import { sha256File } from '../util/hash';
import { isInside } from '../util/paths';
import type { ArchiveService } from './archive';
import { copyTree, removeCreatedByMove, type CreatedByMove } from './archive-root-migration';
import {
  archivedDocsText,
  documentsPhrase,
  exampleList,
  exists,
  planCopy,
  presenceOf,
  samePath,
  toAbs,
  writableBlockers,
  type ArchivedDoc,
  type MigratePlan,
  type RootRoute,
} from './archive-root-plan';
import type { AuditService } from './audit';
import { JobCancelledError, type JobContext, type JobQueueService } from './jobs';
import type { NotificationService } from './notifications';
import type { SettingsService } from './settings';
import type { UndoService } from './undo';

const AUDIT_ACTION = 'archive.changeRoot';
const UNDO_TYPE = 'archive_root_change';
const MIGRATE_JOB = 'archive.migrateRoot';
const CHANGE_RUNNING = 'Der Archivordner wird gerade umgestellt.';

type RootChangeUndoData = RootRoute & CreatedByMove & { mode: ArchiveRootChangeMode };

/** `request`: asked for by the user; `migration`: the running move itself, which already holds the lock. */
type CheckPhase = 'request' | 'migration';

/** Changes the archive root without losing documents: `migrate` copies, verifies and switches (old folder stays), `pathOnly` only switches. */
export class ArchiveRootService {
  constructor(
    private readonly ctx: AppContext,
    private readonly settings: SettingsService,
    private readonly archive: ArchiveService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly jobs: JobQueueService,
    undo: UndoService,
  ) {
    undo.register(UNDO_TYPE, { check: (d) => this.undoCheck(d as RootChangeUndoData), run: (d) => this.undoRun(d as RootChangeUndoData) });
    jobs.register<RootRoute>(MIGRATE_JOB, (job) => this.runMigration(job));
  }

  private get db() {
    return this.ctx.database.db;
  }

  private archivedDocs(): ArchivedDoc[] {
    return this.db
      .select({ id: documents.id, title: documents.title, rel: documents.archiveRelPath, size: documents.size, sha256: documents.sha256 })
      .from(documents)
      .where(and(eq(documents.status, 'archived'), isNotNull(documents.archiveRelPath)))
      .all()
      .map((d) => ({ ...d, rel: d.rel! }));
  }

  /** Checks (by existence and size) whether the archived documents are found under `root`. */
  presence(root: string, docs = this.archivedDocs()): ArchiveRootPresence {
    return presenceOf(root, docs);
  }

  /** Data folders of the app that must never be copied along when the archive lies above the data directory. */
  private excludedFromCopy(from: string): string[] {
    const p = this.ctx.paths;
    return [p.database, p.index, p.config, p.logs, p.backups, p.inbox, p.quarantine, p.trash].filter((dir) => isInside(from, dir) && !samePath(from, dir));
  }

  private normalizeTarget(root: string): string {
    const trimmed = root.trim();
    if (!trimmed) throw validationError('Bitte gib einen Archivpfad an.');
    if (!path.isAbsolute(trimmed)) throw validationError('Bitte gib einen vollständigen (absoluten) Pfad an.');
    return path.resolve(trimmed);
  }

  private commonBlockers(route: RootRoute, phase: CheckPhase): string[] {
    if (samePath(route.from, route.to)) return ['Der neue Pfad ist derselbe wie der bisherige Archivordner.'];
    if (phase === 'request' && (this.archive.isRootChangeActive() || this.jobs.activePayloads(MIGRATE_JOB).length > 0)) return [CHANGE_RUNNING];
    return writableBlockers(route.to);
  }

  /** Reasons that prevent moving the archive from `from` to `to`, and the files that would be copied. */
  private async migratePlan(route: RootRoute, phase: CheckPhase): Promise<MigratePlan> {
    const blockers = this.commonBlockers(route, phase);
    if (blockers.length) return { files: [], dirs: [], alreadyPresent: 0, blockers };
    return planCopy(route, this.excludedFromCopy(route.from));
  }

  /** Current state of the archive root: are the archived documents reachable, and what was the last change. */
  status(): ArchiveRootStatus {
    const root = this.settings.get().archiveRoot;
    const last = this.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, AUDIT_ACTION), eq(auditLog.success, true)))
      .orderBy(desc(auditLog.at))
      .limit(1)
      .get();
    const data = last?.undoData as RootChangeUndoData | null | undefined;
    return {
      root,
      current: this.presence(root),
      lastChange:
        last && data
          ? { auditId: last.id, at: last.at, from: data.from, to: data.to, mode: data.mode, undoable: Boolean(last.undoType) && !last.undoneAt }
          : null,
    };
  }

  /** What changing the archive root to `root` would mean, for both ways. Changes nothing. */
  async preview(root: string): Promise<ArchiveRootPreview> {
    const route = { from: this.settings.get().archiveRoot, to: this.normalizeTarget(root) };
    const docs = this.archivedDocs();
    const plan = await this.migratePlan(route, 'request');
    return {
      ...route,
      atTarget: this.presence(route.to, docs),
      migrate: {
        files: plan.files.length,
        bytes: plan.files.reduce((sum, f) => sum + f.size, 0),
        alreadyPresent: plan.alreadyPresent,
        blockers: plan.blockers,
      },
      pathOnlyBlockers: this.commonBlockers(route, 'request'),
    };
  }

  /** Changes the archive root: `migrate` starts a background job, `pathOnly` switches now (with `acceptMissing` if files lack). */
  async change(input: { root: string; mode: ArchiveRootChangeMode; confirmed: boolean; acceptMissing?: boolean }): Promise<ArchiveRootChangeResult> {
    if (!input.confirmed) throw permissionError('Das Ändern des Archivordners erfordert eine ausdrückliche Bestätigung.');
    const route = { from: this.settings.get().archiveRoot, to: this.normalizeTarget(input.root) };
    if (input.mode === 'migrate') {
      const plan = await this.migratePlan(route, 'request');
      if (plan.blockers.length) throw new AppError('archive_conflict', plan.blockers.join(' '));
      const job = this.jobs.enqueue(MIGRATE_JOB, `Archiv umziehen nach „${route.to}“`, route satisfies RootRoute, { maxAttempts: 1 });
      return { mode: 'migrate', jobId: job.id, auditId: null, unreachable: 0 };
    }
    return this.switchPathOnly(route, input.acceptMissing);
  }

  private switchPathOnly(route: RootRoute, acceptMissing: boolean | undefined): ArchiveRootChangeResult {
    const { from, to } = route;
    const blockers = this.commonBlockers(route, 'request');
    if (blockers.length) throw new AppError('archive_conflict', blockers.join(' '));
    const presence = this.presence(to);
    const unreachable = presence.missing + presence.different;
    if (unreachable > 0 && !acceptMissing)
      throw new AppError(
        'archive_conflict',
        `Im neuen Ordner fehlen ${unreachable} von ${presence.documents} archivierten Dokumenten oder weichen ab (${exampleList(presence.examples)}). Der Archivpfad wurde nicht geändert.`,
      );
    const release = this.archive.beginRootChange();
    let auditId: string;
    try {
      this.settings.update({ archiveRoot: to });
      const undoData: RootChangeUndoData = { mode: 'pathOnly', from, to, created: [], createdDirs: [], createdRoot: false };
      auditId = this.audit.log({
        action: AUDIT_ACTION,
        actor: 'user',
        trigger: 'ui',
        confirmed: true,
        paths: [from, to],
        before: { archiveRoot: from },
        after: { archiveRoot: to, mode: 'pathOnly', unreachable },
        undo: { type: UNDO_TYPE, data: undoData },
      });
    } finally {
      release();
    }
    if (unreachable > 0) this.warnUnreachable(to, presence);
    this.ctx.events.changed('settings', 'documents', 'status', 'audit');
    return { mode: 'pathOnly', jobId: null, auditId, unreachable };
  }

  /** Warns (notification) that archived documents are not reachable under the current archive root. */
  warnUnreachable(root: string, presence = this.presence(root)): void {
    const n = presence.missing + presence.different;
    if (n === 0) return;
    this.notifications.create({
      title: `${archivedDocsText(n)} nicht erreichbar`,
      description: `Im Archivordner „${root}“ fehlen ${n} von ${presence.documents} archivierten Dokumenten oder weichen ab (${exampleList(presence.examples)}). Sie lassen sich nicht öffnen, und die Archivprüfung meldet sie als fehlend. Lege die Dateien dorthin oder stelle den bisherigen Archivpfad wieder her.`,
      type: 'system',
      priority: 'high',
      proposedActions: [{ label: 'Einstellungen öffnen', kind: 'navigate', target: '/settings/' }],
      dedupeKey: `archive-root-unreachable:${root}:${Date.now()}`,
    });
  }

  private async runMigration(job: JobContext<RootRoute>): Promise<unknown> {
    const { from, to } = job.payload;
    const made: CreatedByMove = { created: [], createdDirs: [], createdRoot: false };
    let release: (() => void) | null = null;
    try {
      if (!samePath(this.settings.get().archiveRoot, from))
        throw new AppError('archive_conflict', 'Der Archivpfad wurde inzwischen geändert; der Umzug wurde nicht ausgeführt.');
      release = this.archive.beginRootChange();
      job.report(0, 'Bereite den Umzug vor …');
      const plan = await this.migratePlan({ from, to }, 'migration');
      if (plan.blockers.length) throw new AppError('archive_conflict', plan.blockers.join(' '));
      await copyTree(job, { plan, made });
      job.throwIfCancelled();
      job.report(0.97, 'Prüfe, ob alle archivierten Dokumente am neuen Ort liegen …');
      return this.completeMigration({ from, to }, { made, files: plan.files.length });
    } catch (err) {
      await this.reportFailedMigration({ from, to }, { made, err });
      throw err;
    } finally {
      release?.();
    }
  }

  private completeMigration(route: RootRoute, copied: { made: CreatedByMove; files: number }): unknown {
    const { from, to } = route;
    const { made, files } = copied;
    const presence = this.presence(to);
    if (presence.missing + presence.different > 0)
      throw new AppError(
        'archive_conflict',
        `Nach dem Kopieren fehlen im neuen Ordner ${presence.missing + presence.different} archivierte Dokumente oder weichen ab (${exampleList(presence.examples)}).`,
      );
    this.settings.update({ archiveRoot: to });
    const undoData: RootChangeUndoData = { mode: 'migrate', from, to, ...made };
    const auditId = this.audit.log({
      action: AUDIT_ACTION,
      actor: 'user',
      trigger: 'ui',
      confirmed: true,
      paths: [from, to],
      before: { archiveRoot: from },
      after: { archiveRoot: to, mode: 'migrate', copiedFiles: made.created.length, files },
      undo: { type: UNDO_TYPE, data: undoData },
    });
    this.notifications.create({
      title: 'Archiv umgezogen',
      description: `${archivedDocsText(presence.documents)} (${files} Dateien) liegen jetzt geprüft in „${to}“. Der bisherige Ordner „${from}“ bleibt unverändert erhalten; du kannst ihn löschen, sobald du den neuen Ort geprüft hast. Der Umzug lässt sich in den Einstellungen rückgängig machen.`,
      type: 'system',
      proposedActions: [{ label: 'Einstellungen öffnen', kind: 'navigate', target: '/settings/' }],
    });
    this.ctx.events.changed('settings', 'documents', 'status', 'audit');
    return { auditId, files, copied: made.created.length };
  }

  /** Removes what the failed move created and tells the user; the old archive folder stays active and unchanged. */
  private async reportFailedMigration(route: RootRoute, failure: { made: CreatedByMove; err: unknown }): Promise<void> {
    const { from, to } = route;
    const kept = await removeCreatedByMove(to, failure.made);
    const cancelled = failure.err instanceof JobCancelledError;
    const reason = cancelled ? 'Der Umzug wurde abgebrochen.' : (failure.err as Error).message;
    const leftovers = kept.length
      ? ` Folgende Kopien konnten nicht entfernt werden: ${exampleList(kept)}.`
      : ' Bereits angelegte Kopien wurden wieder entfernt.';
    this.ctx.logger.warn('archive', 'Archive move not completed', { from, to, error: failure.err });
    this.notifications.create({
      title: cancelled ? 'Archivumzug abgebrochen' : 'Archivumzug fehlgeschlagen',
      description: `${reason} Der bisherige Archivordner „${from}“ bleibt aktiv; dort wurde nichts verändert.${leftovers}`,
      type: 'system',
      priority: cancelled ? 'normal' : 'high',
    });
  }

  private async undoCheck(d: RootChangeUndoData): Promise<string[]> {
    if (this.archive.isRootChangeActive()) return [CHANGE_RUNNING];
    if (!samePath(this.settings.get().archiveRoot, d.to)) return ['Der Archivpfad wurde seitdem erneut geändert.'];
    const onlyNew: string[] = [];
    const changed: string[] = [];
    for (const doc of this.archivedDocs()) {
      const now = toAbs(d.to, doc.rel);
      if (!exists(now)) continue; // not reachable now either: switching back cannot make it worse
      const back = toAbs(d.from, doc.rel);
      if (!exists(back)) onlyNew.push(doc.title);
      else if ((await sha256File(back).catch(() => null)) !== (await sha256File(now).catch(() => ''))) changed.push(doc.title);
    }
    const conflicts: string[] = [];
    if (onlyNew.length)
      conflicts.push(
        `${documentsPhrase(onlyNew.length, { singular: 'liegt', plural: 'liegen' })} nur im neuen Archivordner (${exampleList(onlyNew)}) und wären nach dem Zurücksetzen nicht mehr erreichbar.`,
      );
    if (changed.length)
      conflicts.push(
        `${documentsPhrase(changed.length, { singular: 'unterscheidet', plural: 'unterscheiden' })} sich zwischen altem und neuem Archivordner (${exampleList(changed)}).`,
      );
    return conflicts;
  }

  private async undoRun(d: RootChangeUndoData): Promise<string> {
    const release = this.archive.beginRootChange();
    try {
      this.settings.update({ archiveRoot: d.from });
      let message = `Archivpfad auf „${d.from}“ zurückgesetzt.`;
      if (d.mode === 'migrate') {
        const kept = await removeCreatedByMove(d.to, d);
        message += ` Die Kopien im Ordner „${d.to}“ wurden entfernt.`;
        if (kept.length)
          message += ` ${kept.length} Dateien wurden seitdem verändert oder ließen sich nicht entfernen und bleiben dort liegen (${exampleList(kept)}).`;
      }
      this.ctx.events.changed('settings', 'documents', 'status');
      return message;
    } finally {
      release();
    }
  }
}
