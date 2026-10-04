import path from 'node:path';
import { isWithinCategoryFolder } from '../../util/paths';
import type { CheckedDocument } from './documents';
import { fileSizes } from './files';
import { yieldPeriodically, type CheckRun } from './findings';

/** Re-reads an index-only document whose original changed; true if it was refreshed. */
export type IndexRefresher = (id: string, signal?: AbortSignal) => Promise<boolean>;

const absolutePath = (root: string, relativePath: string) => path.join(root, ...relativePath.split('/'));

/** Storage location vs. classification: archive files that are missing, changed in size or outside their category's folder. */
export async function checkStorage(run: CheckRun, archived: CheckedDocument[]): Promise<void> {
  const { deps, findings } = run;
  const root = deps.settings.get().archiveRoot;
  const placed = archived.filter((document) => document.archiveRelPath);
  // asynchronous checks in batches instead of one existsSync per document on the main thread (#215)
  const sizes = await fileSizes(
    placed.map((document) => absolutePath(root, document.archiveRelPath!)),
    run.signal,
  );
  for (const [i, document] of placed.entries()) {
    await yieldPeriodically(i);
    const relativePath = document.archiveRelPath!;
    if (sizes[i] === null) {
      findings.insightKeys.add(`missing-file:${document.id}`);
      deps.insights.upsert({
        kind: 'misplaced_file',
        title: `Archivdatei fehlt: ${document.title}`,
        explanation: `Die Datei wurde am erwarteten Ort nicht gefunden: ${absolutePath(root, relativePath)}. Sie wurde möglicherweise verschoben oder gelöscht.`,
        confidence: 0.95,
        affected: [{ type: 'document', id: document.id, label: document.title }],
        dedupeKey: `missing-file:${document.id}`,
      });
      findings.count('misplaced_file');
    } else if (document.status === 'archived' && sizes[i] !== document.size) {
      reportChangedFile(run, {
        document,
        explanation: `Die Datei ${absolutePath(root, relativePath)} hat eine andere Größe als beim Archivieren (${sizes[i]} statt ${document.size} Byte). Sie wurde möglicherweise überschrieben oder beschädigt.`,
      });
    } else if (document.categoryPath && !isWithinCategoryFolder(path.dirname(relativePath), document.categoryPath)) {
      findings.insightKeys.add(`misplaced:${document.id}`);
      deps.insights.upsert({
        kind: 'misplaced_file',
        title: `Ablageort passt nicht zur Klassifikation: ${document.title}`,
        explanation: `Die Datei liegt in „${path.dirname(relativePath)}“, die Kategorie lautet „${document.categoryPath}“.`,
        confidence: 0.7,
        affected: [{ type: 'document', id: document.id, label: document.title }],
        dedupeKey: `misplaced:${document.id}`,
      });
      findings.count('misplaced_file');
    }
  }
}

/** Hint for an archive file whose size or checksum no longer matches the archived document; one hint per document. */
export function reportChangedFile(run: CheckRun, found: { document: CheckedDocument; explanation: string }): void {
  const { document, explanation } = found;
  const key = `changed-file:${document.id}`;
  if (run.findings.insightKeys.has(key)) return;
  run.findings.insightKeys.add(key);
  run.deps.insights.upsert({
    kind: 'misplaced_file',
    title: `Archivdatei verändert: ${document.title}`,
    explanation,
    confidence: 0.9,
    affected: [{ type: 'document', id: document.id, label: document.title }],
    dedupeKey: key,
  });
  run.findings.count('misplaced_file');
}

/** Index-only documents (#229): a vanished original becomes a hint, a changed one (other size) is re-read in place. */
export async function checkIndexedOriginals(run: CheckRun, request: { archived: CheckedDocument[]; refresh: IndexRefresher }): Promise<void> {
  const indexed = request.archived.filter((document) => document.status === 'indexed_only' && document.sourcePath);
  const sizes = await fileSizes(
    indexed.map((document) => document.sourcePath!),
    run.signal,
  );
  for (const [i, document] of indexed.entries()) {
    await yieldPeriodically(i);
    const size = sizes[i];
    if (size === null) reportMissingOriginal(run, document);
    else if (size !== document.size) await refreshOriginal(run, { document, refresh: request.refresh });
  }
}

function reportMissingOriginal(run: CheckRun, document: CheckedDocument): void {
  run.findings.insightKeys.add(`missing-source:${document.id}`);
  run.deps.insights.upsert({
    kind: 'misplaced_file',
    title: `Original fehlt: ${document.title}`,
    explanation: `Das Dokument ist nur indexiert, sein Original wurde aber nicht mehr gefunden: ${document.sourcePath}. Es wurde möglicherweise verschoben oder gelöscht; die Suche zeigt noch den alten Inhalt.`,
    confidence: 0.95,
    affected: [{ type: 'document', id: document.id, label: document.title }],
    dedupeKey: `missing-source:${document.id}`,
  });
  run.findings.count('misplaced_file');
}

async function refreshOriginal(run: CheckRun, request: { document: CheckedDocument; refresh: IndexRefresher }): Promise<void> {
  const { document } = request;
  try {
    if (await request.refresh(document.id, run.signal)) run.findings.count('refreshed_index');
  } catch (err) {
    if (run.signal?.aborted) throw err;
    run.deps.ctx.logger.warn('consistency', 'Index-only document not refreshed', { documentId: document.id, error: err });
  }
}
