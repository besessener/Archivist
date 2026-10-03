import path from 'node:path';
import type { AppStatus } from '@archivist/shared';
import type { Services } from '../create-services';
import { REEMBED_JOB } from '../services/search';
import { AppError, permissionError } from '../util/errors';
import { isInside } from '../util/paths';
import type { HandlerGroup, HostApi } from './types';

function appStatus(services: Services, host: HostApi): AppStatus {
  const settings = services.settings.get();
  const llm = services.llm.status();
  const counts = services.jobs.counts();
  const secretStorage = host.secretBackend ? host.secretBackend() : services.secrets.status();
  return {
    version: host.version,
    dataRoot: services.paths.root,
    archiveRoot: settings.archiveRoot,
    platform: host.platform,
    setupCompleted: settings.setupCompleted,
    llm: {
      configured: services.llm.isConfigured(),
      hasApiKey: services.secrets.hasApiKey(),
      status: llm.state,
      lastError: llm.lastError,
      lastCheckedAt: llm.lastCheckedAt,
    },
    secretStorage,
    jobs: counts,
    unreadNotifications: services.notifications.unreadCount(),
    openInsights: services.insights.openCount(),
    services: [
      {
        name: 'Datenbank',
        status: services.migration.upToDate ? 'ok' : 'degraded',
        detail: `Migrationen ${services.migration.applied}/${services.migration.total}`,
      },
      {
        name: 'Job-Queue',
        status: counts.failed > 0 ? 'degraded' : 'ok',
        detail: `${counts.pending} wartend, ${counts.running} laufend, ${counts.failed} fehlgeschlagen`,
      },
      { name: 'Worker', status: 'ok', detail: services.pool.mode === 'thread' ? 'Worker-Threads aktiv' : 'Inline-Modus' },
      { name: 'Sicherer Speicher', status: secretStorage.available ? 'ok' : 'error', detail: secretStorage.backend },
    ],
  };
}

/** The existing file of a document, only at a location Archivist itself knows: archive, inbox or the original document. */
function documentPath(services: Services, request: { documentId: string; allowQuarantine?: boolean }): string {
  const document = services.documents.getRow(request.documentId);
  // a quarantined file is suspicious: never open it, only reveal it in the file manager
  if (document.status === 'quarantined' && !request.allowQuarantine)
    throw permissionError('Dateien in Quarantäne werden nicht geöffnet. Nutze „Ordner öffnen“, um sie im Dateimanager zu prüfen.');
  const archiveRoot = services.settings.get().archiveRoot;
  const candidates = [
    document.archiveRelPath ? path.join(archiveRoot, ...document.archiveRelPath.split('/')) : null,
    document.stagedPath,
    document.sourcePath,
  ].filter((candidate): candidate is string => Boolean(candidate));
  const found = candidates.find((candidate) => services.scanner.fileExists(candidate));
  if (!found) throw new AppError('filesystem_error', 'Die Datei wurde nicht gefunden (verschoben oder gelöscht?).');
  const roots = [archiveRoot, services.paths.inbox, ...(request.allowQuarantine ? [services.paths.quarantine] : [])];
  const allowed = roots.some((root) => isInside(root, found)) || found === document.sourcePath;
  if (!allowed) throw permissionError('Dieser Pfad darf nicht geöffnet werden.');
  return found;
}

async function openWithHost(host: HostApi, filePath: string): Promise<{ ok: true }> {
  const error = await host.openPath(filePath);
  if (error) throw new AppError('filesystem_error', 'Die Datei konnte nicht geöffnet werden.', { details: error });
  return { ok: true as const };
}

export function appHandlers(services: Services, host: HostApi): HandlerGroup<'app' | 'settings' | 'llm'> {
  return {
    'app:getStatus': () => appStatus(services, host),
    'app:completeSetup': () => {
      services.settings.update({ setupCompleted: true });
      return { ok: true as const };
    },
    'app:selectDirectory': async (input) => ({ path: await host.selectDirectory(input.title) }),
    'app:openPath': async (input) => openWithHost(host, documentPath(services, { documentId: input.documentId })),
    'app:revealPath': (input) => {
      host.revealPath(documentPath(services, { documentId: input.documentId, allowQuarantine: true }));
      return { ok: true as const };
    },
    'app:openScanFile': async (input) => openWithHost(host, services.scanner.assertOpenable(services.scanner.getFile(input.scanFileId))),

    'settings:get': () => ({ settings: services.settings.get(), hasApiKey: services.secrets.hasApiKey() }),
    'settings:update': (input) => {
      const before = services.settings.get().archiveRoot;
      const embeddingBefore = services.settings.get().llm.embeddingModel;
      if (input.archiveRoot !== undefined && services.archive.isRootChangeActive())
        throw new AppError('archive_conflict', 'Der Archivordner wird gerade umgestellt. Bitte warte, bis das abgeschlossen ist.');
      const settings = services.settings.update(input);
      // a direct path change (without moving the archive) warns when archived documents are not found there
      if (settings.archiveRoot !== before) services.archiveRoot.warnUnreachable(settings.archiveRoot);
      // vectors of another model are useless for the new one: move the entries over in the background (#173)
      if (settings.llm.embeddingModel !== embeddingBefore)
        services.jobs.enqueue(REEMBED_JOB, { label: 'Einträge neu einbetten', sameAs: (_payload, status) => status === 'pending' });
      return { settings };
    },
    'settings:setApiKey': (input) => {
      services.secrets.setApiKey(input.apiKey);
      services.events.changed('settings', 'status');
      return { ok: true as const };
    },
    'settings:clearApiKey': () => {
      services.secrets.clear();
      services.events.changed('settings', 'status');
      return { ok: true as const };
    },

    'llm:testConnection': (input) => services.agent.testConnection({ baseUrl: input.baseUrl, model: input.model, apiKey: input.apiKey }),
    'llm:transmissions': (input) => services.llm.listTransmissions(input.limit),
  };
}
