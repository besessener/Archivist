import path from 'node:path';
import type { ScanExclusion } from '@archivist/shared';
import { and, desc, eq, inArray, like, or } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { documents, scanExclusions, scanFiles } from '../../db/schema';
import { validationError } from '../../util/errors';
import { newId, nowIso } from '../../util/ids';
import { normalizeFsPath } from '../../util/paths';
import type { AuditService } from '../audit';

const mapExclusion = (row: typeof scanExclusions.$inferSelect): ScanExclusion => ({
  id: row.id,
  kind: row.kind as 'file' | 'dir',
  path: row.path,
  createdAt: row.createdAt,
});

export interface ScanExclusionsDeps {
  ctx: AppContext;
  audit: AuditService;
}

/** Files and folders the user never wants to see in a scan again. */
export class ScanExclusions {
  constructor(private readonly deps: ScanExclusionsDeps) {}

  private get db() {
    return this.deps.ctx.database.db;
  }

  exclude(kind: 'file' | 'dir', target: string): ScanExclusion {
    if (!path.isAbsolute(target)) throw validationError('Bitte einen absoluten Pfad angeben.');
    const absolute = normalizeFsPath(target);
    const existing = this.db
      .select()
      .from(scanExclusions)
      .where(and(eq(scanExclusions.kind, kind), eq(scanExclusions.path, absolute)))
      .get();
    const row = existing ?? { id: newId(), kind, path: absolute, createdAt: nowIso() };
    if (!existing) this.db.insert(scanExclusions).values(row).run();
    const below = `${absolute}${path.sep}%`;
    const files = this.db
      .select()
      .from(scanFiles)
      .where(kind === 'file' ? eq(scanFiles.path, absolute) : like(scanFiles.path, below))
      .all();
    for (const file of files) this.db.update(scanFiles).set({ status: 'excluded' }).where(eq(scanFiles.id, file.id)).run();
    // remove not yet archived documents from this location from the inbox
    const inboxDocs = this.db
      .select()
      .from(documents)
      .where(and(inArray(documents.status, ['staged', 'proposed']), kind === 'file' ? eq(documents.sourcePath, absolute) : like(documents.sourcePath, below)))
      .all();
    for (const doc of inboxDocs)
      if (!doc.stagedPath) this.db.update(documents).set({ status: 'ignored', updatedAt: nowIso() }).where(eq(documents.id, doc.id)).run();
    this.deps.audit.log({ action: `scanner.exclude.${kind}`, actor: 'user', trigger: 'manual', confirmed: true, paths: [absolute] });
    this.deps.ctx.events.changed('scanner', 'documents');
    return mapExclusion(row);
  }

  list(): ScanExclusion[] {
    return this.db.select().from(scanExclusions).orderBy(desc(scanExclusions.createdAt)).all().map(mapExclusion);
  }

  remove(id: string): void {
    const row = this.db.select().from(scanExclusions).where(eq(scanExclusions.id, id)).get();
    if (!row) return;
    this.db.delete(scanExclusions).where(eq(scanExclusions.id, id)).run();
    // the files are picked up again on the next scan
    this.db
      .delete(scanFiles)
      .where(and(eq(scanFiles.status, 'excluded'), or(eq(scanFiles.path, row.path), like(scanFiles.path, `${row.path}${path.sep}%`))))
      .run();
    this.deps.audit.log({ action: 'scanner.removeExclusion', actor: 'user', trigger: 'manual', confirmed: true, paths: [row.path] });
    this.deps.ctx.events.changed('scanner');
  }
}
