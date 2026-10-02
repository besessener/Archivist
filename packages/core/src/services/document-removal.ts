import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { documents, scanFiles } from '../db/schema';
import { isInside } from '../util/paths';
import type { DocumentDeps } from './document-model';

/** Deletes `file` only when its real path lies strictly inside one of `roots`; returns the deleted real paths. */
function removeInside(roots: string[], file: string | null): string[] {
  if (!file || !roots.some((r) => isInside(r, file))) return [];
  let real: string;
  try {
    real = fs.realpathSync(file);
  } catch {
    return []; // already gone
  }
  const realRoots = roots.flatMap((r) => {
    try {
      return [fs.realpathSync(r)];
    } catch {
      return [];
    }
  });
  if (!realRoots.some((r) => isInside(r, real) && path.resolve(r) !== path.resolve(real))) return [];
  fs.rmSync(real, { force: true });
  return [real];
}

/** Final deletion through a confirmed critical agent tool (#308): archive file and own inbox copy only, never the original; not undoable. */
export function deleteDocumentPermanently(deps: DocumentDeps, request: { id: string; trigger?: string }): void {
  const { ctx, documents: docs } = deps;
  const { id } = request;
  const db = ctx.database.db;
  const row = docs.getRow(id);
  const deleted = [
    ...(row.archiveMode === 'index_only' ? [] : removeInside([deps.settings.get().archiveRoot], docs.archivePath(row.archiveRelPath))),
    ...removeInside([ctx.paths.inbox, ctx.paths.quarantine], row.stagedPath),
  ];
  ctx.database.transaction(() => {
    db.update(scanFiles).set({ documentId: null }).where(eq(scanFiles.documentId, id)).run();
    db.delete(documents).where(eq(documents.id, id)).run();
  });
  deps.search.remove(id);
  // removes the node together with every relation from or to it
  deps.graph.removeNode(id);
  deps.audit.log({
    action: 'document.delete',
    actor: 'user',
    trigger: request.trigger ?? 'manual',
    confirmed: true,
    entityIds: [id],
    paths: deleted,
    before: { title: row.title, archiveRelPath: row.archiveRelPath },
  });
  ctx.events.changed('documents', 'knowledge');
}
