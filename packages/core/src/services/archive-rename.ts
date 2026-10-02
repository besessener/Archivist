import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { documents } from '../db/schema';
import { sha256File } from '../util/hash';
import { nowIso } from '../util/ids';
import { assertRealInside, resolveInside, sanitizeFileName } from '../util/paths';
import {
  archiveRootOf,
  failureMessage,
  outcomeWithoutChange,
  type ArchiveDeps,
  type ArchiveOutcome,
  type RenamePlanItem,
  type RenameRequest,
  type RenameUndoData,
} from './archive-model';
import type { DocRow } from './documents';

/** Hash- or UUID-like names say nothing about the document and are refused (#304). */
const MEANINGLESS_NAME = /^(?:[0-9a-f]{12,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

const isWindows = () => process.platform === 'win32';

/** A different case of the same name is the same file on NTFS. */
const caseOnlyChange = (from: string, to: string) => isWindows() && to.toLowerCase() === from.toLowerCase();

const stemOf = (rel: string) => path.basename(rel, path.extname(rel));

/** Renames archived files within their folder; never overwrites, checks the checksum, logged with undo. */
export class ArchiveRenamer {
  constructor(private readonly deps: ArchiveDeps) {}

  private get db() {
    return this.deps.ctx.database.db;
  }

  /** Preview of renames: target names, conflicts with existing files and among each other – changes nothing. */
  previewRename(items: RenameRequest[]): RenamePlanItem[] {
    const taken = new Map<string, string>();
    return items.map((req) => this.planOne(req, taken));
  }

  private planOne(req: RenameRequest, taken: Map<string, string>): RenamePlanItem {
    const row = this.deps.docs.getRow(req.documentId);
    const base: RenamePlanItem = { documentId: row.id, from: row.archiveRelPath, to: null, unchanged: false, conflicts: [] };
    if (row.status !== 'archived' || !row.archiveRelPath || row.archiveMode === 'index_only')
      return { ...base, conflicts: ['Nur archivierte Dokumente mit einer Datei im Archiv lassen sich umbenennen.'] };
    let name = sanitizeFileName(req.fileName);
    if (path.extname(name).slice(1).toLowerCase() !== row.ext.toLowerCase()) name = `${name}.${row.ext}`;
    if (MEANINGLESS_NAME.test(stemOf(name))) return { ...base, conflicts: [`„${name}“ ist kein sprechender Name (Hash oder UUID).`] };
    const dir = path.posix.dirname(row.archiveRelPath);
    const toRel = dir === '.' ? name : `${dir}/${name}`;
    if (toRel === row.archiveRelPath) return { ...base, to: toRel, unchanged: true };
    const key = isWindows() ? toRel.toLowerCase() : toRel;
    const conflicts: string[] = [];
    if (taken.has(key)) conflicts.push(`Derselbe Name ist schon für ein anderes Dokument dieser Umbenennung vorgesehen: ${name}`);
    // a different case of the same name is the same file on NTFS – only allowed for the document itself
    else if (fs.existsSync(resolveInside(archiveRootOf(this.deps), toRel)) && !(isWindows() && key === row.archiveRelPath.toLowerCase()))
      conflicts.push(`Im Ordner existiert bereits „${name}“ – es wird nichts überschrieben.`);
    taken.set(key, row.id);
    return { ...base, to: toRel, conflicts };
  }

  /** Renames one planned item; refusals and failures become outcomes, nothing throws. */
  async renameOne(plan: RenamePlanItem, trigger: string | undefined): Promise<ArchiveOutcome> {
    const refuse = (outcome: 'conflict' | 'skipped', message: string) => outcomeWithoutChange({ documentId: plan.documentId, outcome, message });
    if (plan.conflicts.length) return refuse('conflict', plan.conflicts.join(' '));
    if (plan.unchanged || !plan.to || !plan.from) return refuse('skipped', 'Der Name ist bereits so.');
    const move = { fromRel: plan.from, toRel: plan.to };
    return this.deps.locks.onePerDocument(plan.documentId, async () => {
      try {
        return await this.renameFile(this.deps.docs.getRow(plan.documentId), { ...move, trigger });
      } catch (err) {
        return outcomeWithoutChange({ documentId: plan.documentId, outcome: 'failed', message: failureMessage(err) });
      }
    });
  }

  private async renameFile(row: DocRow, rename: { fromRel: string; toRel: string; trigger: string | undefined }): Promise<ArchiveOutcome> {
    const { fromRel, toRel, trigger } = rename;
    const root = archiveRootOf(this.deps);
    const src = resolveInside(root, fromRel);
    await assertRealInside(root, src);
    if ((await sha256File(src)) !== row.sha256)
      return outcomeWithoutChange({
        documentId: row.id,
        outcome: 'conflict',
        message: 'Die Archivdatei wurde seit der Archivierung verändert und wird deshalb nicht umbenannt.',
      });
    const dest = resolveInside(root, toRel);
    const caseOnly = caseOnlyChange(fromRel, toRel);
    if (caseOnly) await fsp.rename(src, dest);
    else await this.deps.files.moveExclusive({ source: src, dir: path.dirname(dest), name: path.basename(dest), sha256: row.sha256, naming: 'exact' });
    const updatedAt = nowIso();
    const title = row.title === stemOf(fromRel) ? stemOf(toRel) : row.title;
    // database, graph and audit entry together – if they fail, the file goes back to its old name (#221)
    const auditId = await this.deps.files.commitOrPutBack({ moved: dest, original: src, sha256: row.sha256, caseOnly }, () => {
      this.db.update(documents).set({ archiveRelPath: toRel, title, updatedAt }).where(eq(documents.id, row.id)).run();
      if (title !== row.title) this.deps.graph.registerNode('document', row.id, title, row.summary);
      const undoData: RenameUndoData = {
        documentId: row.id,
        fromRel,
        toRel,
        sha256: row.sha256,
        beforeTitle: row.title,
        beforeUpdatedAt: row.updatedAt,
        afterUpdatedAt: updatedAt,
      };
      return this.deps.audit.log({
        action: 'archive.rename',
        actor: trigger === 'agent' ? 'agent' : 'user',
        trigger: trigger ?? 'manual',
        confirmed: true,
        entityIds: [row.id],
        paths: [src, dest],
        before: { path: src },
        after: { path: dest },
        undo: { type: 'archive_rename', data: undoData },
      });
    });
    return { documentId: row.id, outcome: 'success', targetPath: dest, message: `Umbenannt in ${path.basename(dest)}.`, auditId };
  }

  async undoCheck(d: RenameUndoData): Promise<string[]> {
    if (this.deps.locks.isRootChangeActive()) return ['Der Archivordner wird gerade umgestellt.'];
    const row = this.db.select().from(documents).where(eq(documents.id, d.documentId)).get();
    if (!row) return ['Das Dokument existiert nicht mehr.'];
    const root = archiveRootOf(this.deps);
    const conflicts: string[] = [];
    if (row.updatedAt !== d.afterUpdatedAt) conflicts.push('Das Dokument wurde seit dem Umbenennen verändert.');
    const now = resolveInside(root, d.toRel);
    if (!fs.existsSync(now)) conflicts.push('Die Datei fehlt unter dem neuen Namen.');
    else if ((await sha256File(now)) !== d.sha256) conflicts.push('Die Datei wurde seit dem Umbenennen verändert.');
    if (!caseOnlyChange(d.fromRel, d.toRel) && fs.existsSync(resolveInside(root, d.fromRel)))
      conflicts.push('Unter dem alten Namen liegt inzwischen eine andere Datei.');
    return conflicts;
  }

  async undoRun(d: RenameUndoData): Promise<string> {
    const root = archiveRootOf(this.deps);
    const now = resolveInside(root, d.toRel);
    const back = resolveInside(root, d.fromRel);
    const caseOnly = caseOnlyChange(d.fromRel, d.toRel);
    if (caseOnly) await fsp.rename(now, back);
    else await this.deps.files.moveExclusive({ source: now, dir: path.dirname(back), name: path.basename(back), sha256: d.sha256, naming: 'exact' });
    // the undo can be retried: if the database refuses, the file goes back to where the database still points (#238)
    await this.deps.files.commitOrPutBack({ moved: back, original: now, sha256: d.sha256, caseOnly }, () => {
      this.db
        .update(documents)
        .set({ archiveRelPath: d.fromRel, title: d.beforeTitle, updatedAt: d.beforeUpdatedAt })
        .where(eq(documents.id, d.documentId))
        .run();
      this.deps.graph.registerNode('document', d.documentId, d.beforeTitle, null);
    });
    this.deps.ctx.events.changed('documents', 'knowledge');
    return 'Umbenennen rückgängig gemacht.';
  }
}
