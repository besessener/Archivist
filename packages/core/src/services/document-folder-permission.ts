import { eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import { documents, scanFiles, scanRoots } from '../db/schema';
import type { PrivacyService } from './privacy';

/** The LLM permission of scan folders as it applies to the documents found in them. */
export class FolderPermission {
  constructor(private readonly deps: { ctx: AppContext; privacy: PrivacyService; reindexInBackground: (documentIds: string[]) => void }) {}

  private get db() {
    return this.deps.ctx.database.db;
  }

  /** false if `p` lies inside a scan folder whose LLM permission is withdrawn. */
  allowedFor(p: string): boolean {
    const locked = this.db.select({ path: scanRoots.path }).from(scanRoots).where(eq(scanRoots.llmAllowed, false)).all();
    return !locked.some((r) => this.deps.privacy.paths.inside(r.path, p));
  }

  /** Stores a scan folder's LLM permission on the documents found in it (other locked folders still apply); returns how many changed. */
  apply(rootId: string): number {
    const root = this.db.select().from(scanRoots).where(eq(scanRoots.id, rootId)).get();
    if (!root) return 0;
    const linked = new Set(
      this.db
        .select({ documentId: scanFiles.documentId })
        .from(scanFiles)
        .where(eq(scanFiles.rootId, rootId))
        .all()
        .flatMap((f) => (f.documentId ? [f.documentId] : [])),
    );
    const rows = this.db
      .select({ id: documents.id, sourcePath: documents.sourcePath, folderLlmAllowed: documents.folderLlmAllowed })
      .from(documents)
      .all()
      .filter((d) => linked.has(d.id) || (d.sourcePath !== null && this.deps.privacy.paths.inside(root.path, d.sourcePath)));
    let changed = 0;
    const lockedIds: string[] = [];
    for (const d of rows) {
      const allowed = root.llmAllowed && (d.sourcePath === null || this.allowedFor(d.sourcePath));
      if (allowed === d.folderLlmAllowed) continue;
      this.db.update(documents).set({ folderLlmAllowed: allowed }).where(eq(documents.id, d.id)).run();
      // remote vectors of a newly locked document are replaced by local ones
      if (!allowed) lockedIds.push(d.id);
      changed += 1;
    }
    this.deps.reindexInBackground(lockedIds);
    if (changed) this.deps.ctx.events.changed('documents');
    return changed;
  }
}
