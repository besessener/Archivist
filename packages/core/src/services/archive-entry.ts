import fs from 'node:fs';
import type { ArchiveItemRequest } from '@archivist/shared';
import type { ArchiveUndoData } from './archive-model';
import type { DocRow } from './documents';
import type { RelationChangeSet } from './knowledge-graph';

export interface ArchivedEntryInput {
  source: string;
  copy: { targetAbs: string | null; archiveRel: string | null };
  removed: { removedStaged: boolean; removedSource: boolean };
  relations: RelationChangeSet;
  afterUpdatedAt: string;
}

/** The parts of the audit entry that depend on which sources were removed. */
export function archivedEntry(archiving: { req: ArchiveItemRequest; row: DocRow; before: ArchiveUndoData['before'] }, done: ArchivedEntryInput) {
  const { req, row, before } = archiving;
  const { removedStaged, removedSource } = done.removed;
  const undoData: ArchiveUndoData = {
    documentId: row.id,
    mode: req.mode,
    archiveRel: done.copy.archiveRel,
    sha256: row.sha256,
    sourcePath: row.sourcePath,
    stagedPath: row.stagedPath,
    removedStaged,
    removedSource,
    before,
    relations: done.relations,
    afterUpdatedAt: done.afterUpdatedAt,
  };
  return {
    after: { status: req.mode === 'index_only' ? 'indexed_only' : 'archived', path: done.copy.targetAbs, removedSource, removedStaged },
    undo: { type: 'archive_file', data: undoData },
  };
}

/** Which sources `removeSources` is about to try to remove. */
export function plannedRemovals(row: DocRow, mode: ArchiveItemRequest['mode']) {
  return {
    removedStaged: Boolean(row.stagedPath && fs.existsSync(row.stagedPath)),
    removedSource: mode === 'move' && Boolean(row.sourcePath && fs.existsSync(row.sourcePath)),
  };
}
