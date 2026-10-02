import fs from 'node:fs';
import path from 'node:path';
import type { Services } from '../../packages/core/src';
import { makePptx } from '../helpers/fixtures';
import { EMPTY_FOLDERS, type EvalDoc } from './fixture';

export interface BuildTarget {
  services: Services;
  /** Directory for the source files of the import (outside the archive). */
  home: string;
}

function assertUniqueKeys(docs: EvalDoc[]): void {
  const keys = new Set<string>();
  for (const doc of docs) {
    if (keys.has(doc.key)) throw new Error(`duplicate fixture key ${doc.key}`);
    keys.add(doc.key);
  }
}

/** Creates the main categories and the empty folders; returns the main categories the archiving may create. */
function prepareFolders(services: Services, docs: EvalDoc[]): string[] {
  const folders = [...docs.flatMap((doc) => (doc.folder ? [doc.folder] : [])), ...EMPTY_FOLDERS];
  const mains = [...new Set(folders.map((folder) => folder.split('/')[0]!))];
  for (const main of mains) if (services.categories.needsApproval(main)) services.categories.create(main, true);
  for (const folder of EMPTY_FOLDERS) services.categories.create(folder, true);
  return mains;
}

/** Writes each document as a source file in its own directory; returns the paths in document order. */
async function writeSources(home: string, docs: EvalDoc[]): Promise<string[]> {
  const sourceDir = path.join(home, 'eval-sources');
  const files: string[] = [];
  for (const [index, doc] of docs.entries()) {
    const file = path.join(sourceDir, String(index).padStart(3, '0'), doc.name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // slide decks are real pptx files (one slide per paragraph), so file type filters meet the real thing
    if (doc.name.endsWith('.pptx')) await makePptx(file, doc.content.split(/\n{2,}/));
    else fs.writeFileSync(file, doc.content);
    files.push(file);
  }
  return files;
}

/** Imports the source files without the LLM; returns key → document id. */
async function importSources(services: Services, sources: { docs: EvalDoc[]; files: string[] }): Promise<Record<string, string>> {
  const result = await services.documents.importPaths(sources.files, { allowLlm: false });
  if (result.rejected.length || result.duplicates.length)
    throw new Error(
      `fixture import failed: ${[...result.rejected.map((rejected) => `${rejected.path}: ${rejected.reason}`), ...result.duplicates.map((duplicate) => `${duplicate.path}: duplicate`)].join('; ')}`,
    );
  await services.jobs.whenIdle();
  const ids: Record<string, string> = {};
  sources.docs.forEach((doc, index) => {
    const imported = result.imported.find((candidate) => candidate.sourcePath === fs.realpathSync(sources.files[index]!));
    if (!imported) throw new Error(`fixture document ${doc.key} not imported`);
    ids[doc.key] = imported.id;
  });
  return ids;
}

async function archiveIntoFolders(services: Services, archiving: { docs: EvalDoc[]; ids: Record<string, string>; mains: string[] }): Promise<void> {
  const toArchive = archiving.docs.filter((doc) => doc.folder);
  if (!toArchive.length) return;
  const result = await services.archive.execute(
    toArchive.map((doc) => ({
      documentId: archiving.ids[doc.key]!,
      mode: 'copy' as const,
      categoryPath: doc.folder!,
      topic: doc.topic ?? null,
      project: null,
    })),
    { confirmed: true, approveNewCategories: archiving.mains, confirmMove: false, trigger: 'eval-setup' },
  );
  if (result.success !== toArchive.length)
    throw new Error(
      `fixture archiving failed: ${result.items
        .filter((item) => item.outcome !== 'success')
        .map((item) => item.message)
        .join('; ')}`,
    );
}

function metadataPatch(doc: EvalDoc) {
  return {
    ...(doc.title ? { title: doc.title } : {}),
    ...(doc.docType !== undefined ? { docType: doc.docType } : {}),
    ...(doc.documentDate !== undefined ? { documentDate: doc.documentDate } : {}),
    ...(doc.persons?.length ? { addPersons: doc.persons } : {}),
    ...(doc.tags?.length ? { addTags: doc.tags } : {}),
    ...(!doc.folder && doc.topic ? { topic: doc.topic } : {}),
  };
}

/** Builds the archive deterministically without any LLM call; returns key → document id. */
export async function buildArchive(target: BuildTarget, docs: EvalDoc[]): Promise<Record<string, string>> {
  const { services } = target;
  assertUniqueKeys(docs);
  const previousMode = services.settings.get().privacy.llmMode;
  services.settings.update({ privacy: { llmMode: 'local_only' } });
  try {
    const mains = prepareFolders(services, docs);
    const files = await writeSources(target.home, docs);
    const ids = await importSources(services, { docs, files });
    await archiveIntoFolders(services, { docs, ids, mains });
    for (const doc of docs) {
      const id = ids[doc.key]!;
      services.documents.bulkUpdate([id], metadataPatch(doc), { trigger: 'eval-setup' });
      if (doc.excluded) services.documents.setLlmExcluded(id, true);
    }
    await Promise.all(Object.values(ids).map((id) => services.documents.indexDocument(id)));
    await services.jobs.whenIdle();
    return ids;
  } finally {
    services.settings.update({ privacy: { llmMode: previousMode } });
  }
}
