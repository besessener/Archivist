import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { DocumentRecord } from '@archivist/shared';
import { folderLabel, folderOf } from '../../../services/archive-structure';
import type { DocRow } from '../../../services/documents';
import { assertRealInside, sanitizeFileName, uniquePath } from '../../../util/paths';
import type { ToolDeps, ToolScope } from '../common';
import { labelledTotal } from '../research/amounts';
import type { ExportItem } from './items';

export const today = () => new Date().toISOString().slice(0, 10);

/** A file the agent produces in the export folder of the data directory. */
export interface ExportFile {
  title: string;
  extension: string;
  data: string | Uint8Array;
}

async function exportPath(deps: ToolDeps, { title, extension }: Pick<ExportFile, 'title' | 'extension'>): Promise<string> {
  const dir = path.join(deps.paths.root, 'exports');
  await fsp.mkdir(dir, { recursive: true });
  // a symlinked export folder must not lead out of the data folder (#301)
  await assertRealInside(deps.paths.root, dir);
  return uniquePath(dir, sanitizeFileName(`${title.trim() || 'Export'} ${today()}.${extension}`, 'Export'));
}

/** Writes a new file (never overwrites) and records it for the run. */
export async function writeExport({ deps, ctx }: ToolScope, file: ExportFile): Promise<string> {
  const target = await exportPath(deps, file);
  await fsp.writeFile(target, file.data, { flag: 'wx' });
  ctx.files.push(target);
  return target;
}

function readablePath(deps: ToolDeps, row: DocRow): string | null {
  try {
    return deps.docs.readablePath(row);
  } catch {
    return null;
  }
}

export function collectItems(deps: ToolDeps, docs: DocumentRecord[]): ExportItem[] {
  return docs.map((doc) => {
    const row = deps.docs.findRow(doc.id);
    const archived = doc.archivePath && fs.existsSync(doc.archivePath) ? doc.archivePath : null;
    return {
      doc,
      file: archived ?? (row ? readablePath(deps, row) : null),
      amount: row ? (labelledTotal(row.extractedText)?.amount ?? null) : null,
      folder: doc.archiveRelPath ? folderLabel(folderOf(doc)) : '–',
    };
  });
}
