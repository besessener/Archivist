import type { Services } from '../create-services';
import { DOCUMENT_REINDEX_JOB } from '../services/document-index';
import { enqueueReembedding } from '../services/reembedding';
import { fillPattern } from '../services/rename-pattern';
import { UI_TRIGGER, type HandlerGroup, type HostApi } from './types';

/** Rename requests for a scheme: each document gets its own name from its metadata. */
function renameByPattern(services: Services, request: { ids: string[]; pattern: string }) {
  const byId = new Map(services.documents.list({ ids: request.ids, limit: request.ids.length }).map((document) => [document.id, document]));
  // in the order of the selection: of two equal names the first selected one gets it
  return request.ids.flatMap((id) => {
    const document = byId.get(id);
    return document ? [{ documentId: id, fileName: fillPattern(request.pattern, document) }] : [];
  });
}

/** Documents, the scanner, categories, backups and the archive folder. */
export function documentHandlers(services: Services, host: HostApi): HandlerGroup<'documents' | 'trash' | 'scanner' | 'categories' | 'backup' | 'archive'> {
  return {
    'documents:import': async (input) => services.documents.importPaths(input.paths),
    'documents:list': async (input) => services.documents.recordsFrom(await services.reader.run('documentList', input)),
    'documents:counts': () => services.reader.run('documentCounts', {}),
    'documents:count': (input) => services.reader.run('documentCount', input),
    'documents:get': (input) => services.documents.get(input.id),
    'documents:archiveAllPreview': (input) => services.archiveAll.preview(input.source),
    'documents:archiveAll': (input) => ({ jobId: services.archiveAll.enqueue(input).id }),
    'documents:analyzeImportEstimate': (input) => services.importAnalysis.estimate(input.jobId),
    'documents:analyzeImport': (input) => ({ jobId: services.importAnalysis.enqueue(input).id }),
    'documents:classify': (input) => ({ jobId: services.documents.enqueueAnalysis(input.documentId, { allowLlm: input.allowLlm }) }),
    'documents:previewArchive': (input) => services.archive.preview(input.items),
    'documents:archive': (input) =>
      services.archive.execute(input.items, {
        confirmed: input.confirmed,
        approveNewCategories: input.approveNewCategories,
        confirmMove: input.confirmMove,
        trigger: 'manual',
      }),
    'documents:undoArchive': (input) => services.undo.undo(input.auditId),
    'documents:updateMetadata': (input) =>
      services.documents.updateMetadata(input.id, {
        patch: { title: input.title, topic: input.topic, project: input.project, tags: input.tags, persons: input.persons },
        confirmed: input.confirmed,
      }),
    'documents:bulkUpdate': (input) => {
      const { ids, confirmed: _confirmed, ...patch } = input;
      void _confirmed;
      const result = services.documents.bulkUpdate(ids, { patch, trigger: UI_TRIGGER });
      return { updated: result.updated.length, auditId: result.auditId };
    },
    'documents:relocate': (input) =>
      services.archive.relocate(
        input.ids.map((documentId) => ({ documentId, categoryPath: services.categories.canonical(input.categoryPath) })),
        { confirmed: true, trigger: UI_TRIGGER },
      ),
    'documents:previewRename': (input) => services.archive.previewRename(renameByPattern(services, input)),
    'documents:rename': (input) => services.archive.rename(renameByPattern(services, input), { confirmed: true, trigger: UI_TRIGGER }),
    'documents:ignore': (input) => services.documents.ignore(input.id),
    'documents:forTopic': (input) => {
      const subject = services.graph.getEntity(input.topicId);
      return services.documents.list({ [subject?.type === 'project' ? 'projectId' : 'topicId']: input.topicId, limit: 500 });
    },
    'documents:setLlmExcluded': (input) => services.documents.setLlmExcluded(input.id, { excluded: input.excluded }),
    'documents:releaseQuarantine': (input) => services.documents.releaseFromQuarantine(input.id, { confirmed: input.confirmed }),
    'documents:trash': (input) => services.documents.moveToTrash(input.id, { confirmed: input.confirmed, trigger: 'manual' }),
    'documents:reanalysis': (input) => services.documents.reanalysis.get(input.id),
    'documents:reanalysisPending': () => ({ documentIds: services.documents.reanalysis.pendingIds() }),
    'documents:applyReanalysis': (input) => services.documents.reanalysis.apply(input.id, { confirmed: input.confirmed }),
    'documents:discardReanalysis': (input) => {
      services.documents.reanalysis.discard(input.id);
      return { ok: true as const };
    },
    'documents:reprocessEstimate': (input) => services.reprocessing.estimate(input.ids),
    'documents:reprocess': (input) => ({ jobId: services.reprocessing.enqueue(input).id }),
    'documents:indexStatus': () => services.documents.indexRepair.status(),
    'documents:rebuildIndex': () => ({
      jobId: services.jobs.enqueue(DOCUMENT_REINDEX_JOB, { label: 'Suchindex ergänzen', sameAs: () => true, maxAttempts: 1 }).id,
    }),
    'documents:reembed': () => ({ jobId: enqueueReembedding(services.jobs).id }),
    'trash:list': () => services.documents.trashEntries(),
    'trash:empty': (input) => services.documents.emptyTrash(input),

    'scanner:addDirectory': (input) => services.scanner.addDirectory(input.path, { recursive: input.recursive }),
    'scanner:removeDirectory': (input) => {
      services.scanner.removeDirectory(input.id);
      return { ok: true as const };
    },
    'scanner:updateDirectory': (input) => {
      const { id, ...patch } = input;
      return services.scanner.updateDirectory(id, patch);
    },
    'scanner:listDirectories': () => services.scanner.listDirectories(),
    'scanner:start': (input) => ({ jobId: services.scanner.startScan(input.rootId).id }),
    'scanner:getResults': (input) => services.scanner.getResults(input),
    'scanner:analyze': (input) => ({
      jobId: services.jobs.enqueue('scanner.analyze', {
        label: `Analysiere ${input.fileIds.length} Datei(en)`,
        payload: { fileIds: input.fileIds, confirmLlm: input.confirmLlm, reanalyze: input.reanalyze },
        maxAttempts: 1,
      }).id,
    }),
    'scanner:analyzeAllPreview': () => services.scanner.bulk.estimate(),
    'scanner:analyzeAll': (input) => ({ jobId: services.scanner.bulk.enqueue({ confirmLlm: input.confirmLlm }).id }),
    'scanner:proposals': () => services.scanner.proposals(),
    'scanner:exclude': (input) => services.scanner.exclude(input.kind, input.path),
    'scanner:listExclusions': () => services.scanner.listExclusions(),
    'scanner:removeExclusion': (input) => {
      services.scanner.removeExclusion(input.id);
      return { ok: true as const };
    },

    'categories:list': () => services.categories.list(),
    'categories:create': (input) => services.archive.createCategory(input.path, { confirmed: input.confirmed }),
    'backup:create': (input) => services.backup.create({ includeArchive: input.includeArchive }),
    'backup:list': () => services.backup.list(),
    'backup:storage': () => services.backup.storage(),
    'backup:restore': (input) => {
      services.backup.requestRestore(input.name);
      host.restartApp?.();
      return { restartRequired: true as const };
    },
    'archive:verify': () => services.archive.verify(),
    'archive:relink': (input) => services.archive.relink({ confirmed: input.confirmed }),
    'archive:rootStatus': () => services.archiveRoot.status(),
    'archive:previewRootChange': (input) => services.archiveRoot.preview(input.root),
    'archive:changeRoot': (input) => services.archiveRoot.change(input),
  };
}
