import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ArchiveRootChangeMode, ArchiveRootChangeResult, ArchiveRootPresence, ArchiveRootPreview, ArchiveRootStatus } from '@archivist/shared';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { AppContext } from '../context';
import { auditLog, documents } from '../db/schema';
import { AppError, fsError, permissionError, validationError } from '../util/errors';
import { sha256File } from '../util/hash';
import { isInside } from '../util/paths';
import type { ArchiveService } from './archive';
import type { AuditService } from './audit';
import { JobCancelledError, type JobContext, type JobQueueService } from './jobs';
import type { NotificationService } from './notifications';
import type { SettingsService } from './settings';
import type { UndoService } from './undo';

const AUDIT_ACTION = 'archive.changeRoot';
const UNDO_TYPE = 'archive_root_change';
const MIGRATE_JOB = 'archive.migrateRoot';
/** Suffix of the temporary file a copy is written to before it gets its final name in the new folder. */
const PARTIAL_SUFFIX = '.archivist-partial';
const MAX_EXAMPLES = 5;

interface RootChangeUndoData {
  mode: ArchiveRootChangeMode;
  from: string;
  to: string;
  /** Files the move copied into the new folder (relative POSIX path + checksum); undo removes them if unchanged. */
  created: Array<{ rel: string; sha256: string }>;
  /** Directories the move created (relative POSIX paths); undo removes them again if they are empty. */
  createdDirs: string[];
  /** The move created the new archive folder itself. */
  createdRoot: boolean;
}

interface MigratePayload {
  from: string;
  to: string;
}

interface ArchivedDoc {
  id: string;
  title: string;
  rel: string;
  size: number;
  sha256: string;
}

interface TreeFile {
  rel: string;
  size: number;
}

const errCode = (err: unknown) => (err as NodeJS.ErrnoException | null)?.code;
const toAbs = (root: string, rel: string) => path.join(root, ...rel.split('/'));
const exists = (p: string) => fs.existsSync(p);

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`;
}

/** German list of the first examples, with “… und N weitere” for the rest. */
function exampleList(items: string[]): string {
  const shown = items.slice(0, MAX_EXAMPLES).map((t) => `„${t}“`);
  return items.length > MAX_EXAMPLES ? `${shown.join(', ')} und ${items.length - MAX_EXAMPLES} weitere` : shown.join(', ');
}

/** “1 Dokument liegt” / “2 Dokumente liegen”: noun phrase plus the verb in singular or plural. */
const docs = (n: number, singular: string, plural: string) => (n === 1 ? `1 Dokument ${singular}` : `${n} Dokumente ${plural}`);
const archivedDocsText = (n: number) => (n === 1 ? '1 archiviertes Dokument' : `${n} archivierte Dokumente`);

/** Nearest existing ancestor of `p` (or `p` itself). */
function existingAncestor(p: string): string {
  let current = path.resolve(p);
  while (!exists(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const resolved = path.resolve(p);
    try {
      return fs.realpathSync(resolved);
    } catch {
      return resolved;
    }
  };
  const [x, y] = [norm(a), norm(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * Changing the archive root without losing the archived documents. Archived documents store their path relative to the
 * archive root, so the new root must contain the same files at the same relative paths. Two ways:
 *  - `migrate`: copy the whole archive folder into the new folder (never overwriting anything), verify every copy by
 *    checksum, then switch. The old folder stays untouched; undo switches back and removes the unchanged copies.
 *  - `pathOnly`: the files are already there (e.g. moved by hand); only switch, after checking that they are present.
 */
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
    jobs.register<MigratePayload>(MIGRATE_JOB, (job) => this.runMigration(job));
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
    const out: ArchiveRootPresence = { documents: docs.length, present: 0, missing: 0, different: 0, examples: [] };
    for (const d of docs) {
      let size: number | null;
      try {
        const st = fs.statSync(toAbs(root, d.rel));
        size = st.isFile() ? st.size : -1;
      } catch {
        size = null;
      }
      if (size === d.size) out.present += 1;
      else {
        if (size === null) out.missing += 1;
        else out.different += 1;
        if (out.examples.length < MAX_EXAMPLES) out.examples.push(d.title);
      }
    }
    return out;
  }

  /** Data folders of the app that must never be copied along when the archive lies above the data directory. */
  private excludedFromCopy(from: string): string[] {
    const p = this.ctx.paths;
    return [p.database, p.index, p.config, p.logs, p.backups, p.inbox, p.quarantine].filter((dir) => isInside(from, dir) && !samePath(from, dir));
  }

  /** All regular files below `from` (symlinks are not followed), plus the directories (relative POSIX paths). */
  private async listTree(from: string, excluded: string[]): Promise<{ files: TreeFile[]; dirs: string[] }> {
    const files: TreeFile[] = [];
    const dirs: string[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (excluded.some((x) => isInside(x, full))) continue;
        if (e.isDirectory()) {
          dirs.push(childRel);
          await walk(full, childRel);
        } else if (e.isFile()) files.push({ rel: childRel, size: (await fsp.stat(full)).size });
      }
    };
    await walk(from, '');
    return { files, dirs };
  }

  private normalizeTarget(root: string): string {
    const trimmed = root.trim();
    if (!trimmed) throw validationError('Bitte gib einen Archivpfad an.');
    if (!path.isAbsolute(trimmed)) throw validationError('Bitte gib einen vollständigen (absoluten) Pfad an.');
    return path.resolve(trimmed);
  }

  /** `inMigration`: called by the running move itself, which already holds the lock. */
  private commonBlockers(from: string, to: string, inMigration = false): string[] {
    if (samePath(from, to)) return ['Der neue Pfad ist derselbe wie der bisherige Archivordner.'];
    if (!inMigration && (this.archive.isRootChangeActive() || this.jobs.activePayloads(MIGRATE_JOB).length > 0))
      return ['Der Archivordner wird gerade umgestellt.'];
    const ancestor = existingAncestor(to);
    try {
      if (!fs.statSync(ancestor).isDirectory()) return [`„${ancestor}“ ist kein Ordner.`];
      fs.accessSync(ancestor, fs.constants.W_OK);
    } catch {
      return ['Der neue Ordner ist nicht beschreibbar.'];
    }
    return [];
  }

  /** Reasons that prevent moving the archive from `from` to `to`, and the files that would be copied. */
  private async migratePlan(
    from: string,
    to: string,
    inMigration = false,
  ): Promise<{ files: TreeFile[]; dirs: string[]; alreadyPresent: number; blockers: string[] }> {
    const blockers = this.commonBlockers(from, to, inMigration);
    if (blockers.length) return { files: [], dirs: [], alreadyPresent: 0, blockers };
    if (!exists(from))
      return { files: [], dirs: [], alreadyPresent: 0, blockers: ['Der bisherige Archivordner existiert nicht mehr – es gibt nichts umzuziehen.'] };
    if (isInside(from, to)) return { files: [], dirs: [], alreadyPresent: 0, blockers: ['Der neue Ordner liegt innerhalb des bisherigen Archivordners.'] };
    if (isInside(to, from)) return { files: [], dirs: [], alreadyPresent: 0, blockers: ['Der bisherige Archivordner liegt innerhalb des neuen Ordners.'] };
    const { files, dirs } = await this.listTree(from, this.excludedFromCopy(from));
    let alreadyPresent = 0;
    let bytesToCopy = 0;
    const taken: string[] = [];
    for (const f of files) {
      let st: fs.Stats | null;
      try {
        st = fs.lstatSync(toAbs(to, f.rel));
      } catch {
        st = null;
      }
      if (!st) bytesToCopy += f.size;
      else if (st.isFile() && st.size === f.size) alreadyPresent += 1;
      else taken.push(f.rel);
    }
    if (taken.length)
      blockers.push(`Im neuen Ordner liegen bereits andere Dateien unter denselben Namen: ${exampleList(taken)}. Archivist überschreibt nichts.`);
    try {
      const st = fs.statfsSync(existingAncestor(to));
      const free = st.bavail * st.bsize;
      if (free < bytesToCopy) blockers.push(`Am neuen Ort ist nicht genug Speicherplatz frei (benötigt ${formatMb(bytesToCopy)}, frei ${formatMb(free)}).`);
    } catch {
      /* free space unknown: the copy itself reports a full disk */
    }
    return { files, dirs, alreadyPresent, blockers };
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
    const from = this.settings.get().archiveRoot;
    const to = this.normalizeTarget(root);
    const docs = this.archivedDocs();
    const plan = await this.migratePlan(from, to);
    return {
      from,
      to,
      atTarget: this.presence(to, docs),
      migrate: {
        files: plan.files.length,
        bytes: plan.files.reduce((sum, f) => sum + f.size, 0),
        alreadyPresent: plan.alreadyPresent,
        blockers: plan.blockers,
      },
      pathOnlyBlockers: this.commonBlockers(from, to),
    };
  }

  /**
   * Changes the archive root. `migrate` starts a background job (copy, verify, switch); `pathOnly` switches right away,
   * but only with `acceptMissing` when archived documents are missing in the new folder.
   */
  async change(input: { root: string; mode: ArchiveRootChangeMode; confirmed: boolean; acceptMissing?: boolean }): Promise<ArchiveRootChangeResult> {
    if (!input.confirmed) throw permissionError('Das Ändern des Archivordners erfordert eine ausdrückliche Bestätigung.');
    const from = this.settings.get().archiveRoot;
    const to = this.normalizeTarget(input.root);
    if (input.mode === 'migrate') {
      const plan = await this.migratePlan(from, to);
      if (plan.blockers.length) throw new AppError('archive_conflict', plan.blockers.join(' '));
      const job = this.jobs.enqueue(MIGRATE_JOB, `Archiv umziehen nach „${to}“`, { from, to } satisfies MigratePayload, { maxAttempts: 1 });
      return { mode: 'migrate', jobId: job.id, auditId: null, unreachable: 0 };
    }
    const blockers = this.commonBlockers(from, to);
    if (blockers.length) throw new AppError('archive_conflict', blockers.join(' '));
    const presence = this.presence(to);
    const unreachable = presence.missing + presence.different;
    if (unreachable > 0 && !input.acceptMissing)
      throw new AppError(
        'archive_conflict',
        `Im neuen Ordner fehlen ${unreachable} von ${presence.documents} archivierten Dokumenten oder weichen ab (${exampleList(presence.examples)}). Der Archivpfad wurde nicht geändert.`,
      );
    const release = this.archive.beginRootChange();
    let auditId: string;
    try {
      this.settings.update({ archiveRoot: to });
      auditId = this.audit.log({
        action: AUDIT_ACTION,
        actor: 'user',
        trigger: 'ui',
        confirmed: true,
        paths: [from, to],
        before: { archiveRoot: from },
        after: { archiveRoot: to, mode: 'pathOnly', unreachable },
        undo: { type: UNDO_TYPE, data: { mode: 'pathOnly', from, to, created: [], createdDirs: [], createdRoot: false } satisfies RootChangeUndoData },
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

  // ---------- Move (background job) ----------
  /**
   * Copies `src` to `dest` without ever overwriting: written under a temporary name first, verified by checksum, then
   * given its final name. Returns the checksum, or null when an identical file already exists at `dest`.
   */
  private async copyVerified(src: string, dest: string, rel: string): Promise<string | null> {
    const sha = await sha256File(src);
    if (exists(dest)) {
      if ((await sha256File(dest).catch(() => null)) === sha) return null;
      throw new AppError('archive_conflict', `Im neuen Ordner liegt bereits eine andere Datei unter „${rel}“. Archivist überschreibt nichts.`);
    }
    const tmp = `${dest}${PARTIAL_SUFFIX}`;
    await fsp.rm(tmp, { force: true }); // leftover of an interrupted earlier move (our own temporary name)
    try {
      await fsp.copyFile(src, tmp, fs.constants.COPYFILE_EXCL);
      if ((await sha256File(tmp)) !== sha) throw fsError(`Die Kopie von „${rel}“ stimmt nicht mit dem Original überein.`);
      try {
        await fsp.link(tmp, dest); // fails if dest exists: never overwrites
        await fsp.unlink(tmp);
      } catch (err) {
        if (errCode(err) === 'EEXIST')
          throw new AppError('archive_conflict', `Im neuen Ordner liegt bereits eine Datei unter „${rel}“. Archivist überschreibt nichts.`);
        // file system without hard links
        if (exists(dest)) throw new AppError('archive_conflict', `Im neuen Ordner liegt bereits eine Datei unter „${rel}“. Archivist überschreibt nichts.`);
        await fsp.rename(tmp, dest);
      }
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
      if (err instanceof AppError) throw err;
      throw fsError(`„${rel}“ konnte nicht kopiert werden${errCode(err) ? ` (${errCode(err)})` : ''}.`, err);
    }
    return sha;
  }

  /** Removes copies and directories a move created (best effort); returns the files that could not be removed. */
  private async removeCreated(to: string, created: RootChangeUndoData['created'], createdDirs: string[], createdRoot: boolean): Promise<{ kept: string[] }> {
    const kept: string[] = [];
    for (const f of created) {
      const abs = toAbs(to, f.rel);
      try {
        if ((await sha256File(abs)) === f.sha256) await fsp.unlink(abs);
        else kept.push(f.rel);
      } catch (err) {
        if (errCode(err) !== 'ENOENT') kept.push(f.rel);
      }
    }
    const depth = (rel: string) => rel.split('/').length;
    for (const rel of [...createdDirs].sort((a, b) => depth(b) - depth(a))) await fsp.rmdir(toAbs(to, rel)).catch(() => undefined);
    if (createdRoot) await fsp.rmdir(to).catch(() => undefined);
    return { kept };
  }

  private async runMigration(job: JobContext<MigratePayload>): Promise<unknown> {
    const { from, to } = job.payload;
    const created: RootChangeUndoData['created'] = [];
    const createdDirs: string[] = [];
    let createdRoot = false;
    let release: (() => void) | null = null;
    try {
      if (!samePath(this.settings.get().archiveRoot, from))
        throw new AppError('archive_conflict', 'Der Archivpfad wurde inzwischen geändert; der Umzug wurde nicht ausgeführt.');
      release = this.archive.beginRootChange();
      job.report(0, 'Bereite den Umzug vor …');
      const plan = await this.migratePlan(from, to, true);
      if (plan.blockers.length) throw new AppError('archive_conflict', plan.blockers.join(' '));
      createdRoot = !exists(to);
      await fsp.mkdir(to, { recursive: true });
      for (const rel of plan.dirs) {
        try {
          await fsp.mkdir(toAbs(to, rel));
          createdDirs.push(rel);
        } catch (err) {
          if (errCode(err) !== 'EEXIST') throw fsError(`Der Ordner „${rel}“ konnte nicht angelegt werden.`, err);
        }
      }
      const total = plan.files.length;
      for (const [i, f] of plan.files.entries()) {
        job.throwIfCancelled();
        job.report(total ? (i / total) * 0.95 : 0, `Kopiere und prüfe Datei ${i + 1} von ${total} …`);
        const sha = await this.copyVerified(toAbs(from, f.rel), toAbs(to, f.rel), f.rel);
        if (sha) created.push({ rel: f.rel, sha256: sha });
      }
      job.throwIfCancelled();
      job.report(0.97, 'Prüfe, ob alle archivierten Dokumente am neuen Ort liegen …');
      const presence = this.presence(to);
      if (presence.missing + presence.different > 0)
        throw new AppError(
          'archive_conflict',
          `Nach dem Kopieren fehlen im neuen Ordner ${presence.missing + presence.different} archivierte Dokumente oder weichen ab (${exampleList(presence.examples)}).`,
        );
      this.settings.update({ archiveRoot: to });
      const undoData: RootChangeUndoData = { mode: 'migrate', from, to, created, createdDirs, createdRoot };
      const auditId = this.audit.log({
        action: AUDIT_ACTION,
        actor: 'user',
        trigger: 'ui',
        confirmed: true,
        paths: [from, to],
        before: { archiveRoot: from },
        after: { archiveRoot: to, mode: 'migrate', copiedFiles: created.length, files: total },
        undo: { type: UNDO_TYPE, data: undoData },
      });
      this.notifications.create({
        title: 'Archiv umgezogen',
        description: `${archivedDocsText(presence.documents)} (${total} Dateien) liegen jetzt geprüft in „${to}“. Der bisherige Ordner „${from}“ bleibt unverändert erhalten; du kannst ihn löschen, sobald du den neuen Ort geprüft hast. Der Umzug lässt sich in den Einstellungen rückgängig machen.`,
        type: 'system',
        proposedActions: [{ label: 'Einstellungen öffnen', kind: 'navigate', target: '/settings/' }],
      });
      this.ctx.events.changed('settings', 'documents', 'status', 'audit');
      return { auditId, files: total, copied: created.length };
    } catch (err) {
      const { kept } = await this.removeCreated(to, created, createdDirs, createdRoot);
      const cancelled = err instanceof JobCancelledError;
      const reason = cancelled ? 'Der Umzug wurde abgebrochen.' : (err as Error).message;
      const leftovers = kept.length
        ? ` Folgende Kopien konnten nicht entfernt werden: ${exampleList(kept)}.`
        : ' Bereits angelegte Kopien wurden wieder entfernt.';
      this.ctx.logger.warn('archive', 'Archivumzug nicht abgeschlossen', { from, to, error: err });
      this.notifications.create({
        title: cancelled ? 'Archivumzug abgebrochen' : 'Archivumzug fehlgeschlagen',
        description: `${reason} Der bisherige Archivordner „${from}“ bleibt aktiv; dort wurde nichts verändert.${leftovers}`,
        type: 'system',
        priority: cancelled ? 'normal' : 'high',
      });
      throw err;
    } finally {
      release?.();
    }
  }

  // ---------- Undo ----------
  private async undoCheck(d: RootChangeUndoData): Promise<string[]> {
    if (this.archive.isRootChangeActive()) return ['Der Archivordner wird gerade umgestellt.'];
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
        `${docs(onlyNew.length, 'liegt', 'liegen')} nur im neuen Archivordner (${exampleList(onlyNew)}) und wären nach dem Zurücksetzen nicht mehr erreichbar.`,
      );
    if (changed.length)
      conflicts.push(`${docs(changed.length, 'unterscheidet', 'unterscheiden')} sich zwischen altem und neuem Archivordner (${exampleList(changed)}).`);
    return conflicts;
  }

  private async undoRun(d: RootChangeUndoData): Promise<string> {
    const release = this.archive.beginRootChange();
    try {
      this.settings.update({ archiveRoot: d.from });
      let message = `Archivpfad auf „${d.from}“ zurückgesetzt.`;
      if (d.mode === 'migrate') {
        const { kept } = await this.removeCreated(d.to, d.created, d.createdDirs, d.createdRoot);
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
