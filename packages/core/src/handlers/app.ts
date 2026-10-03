import path from 'node:path';
import type { AppStatus } from '@archivist/shared';
import type { Services } from '../create-services';
import type { DocRow } from '../services/document-model';
import { enqueueReembedding } from '../services/reembedding';
import { settingsChanges } from '../services/settings-changes';
import { AppError, permissionError } from '../util/errors';
import { isInside } from '../util/paths';
import { detectSyncFolder } from '../util/sync-folders';
import { UI_TRIGGER, type HandlerGroup, type HostApi } from './types';

function appStatus(services: Services, host: HostApi): AppStatus {
  const settings = services.settings.get();
  const llm = services.llm.status();
  const counts = services.jobs.counts();
  const secretStorage = host.secretBackend ? host.secretBackend() : services.secrets.status();
  return {
    version: host.version,
    dataRoot: services.paths.root,
    archiveRoot: settings.archiveRoot,
    archiveSyncProvider: detectSyncFolder(settings.archiveRoot),
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

const ARCHIVE_COPY_MISSING =
  'Die Archivkopie dieses Dokuments fehlt und es gibt keine unveränderte Kopie an anderer Stelle. Wurde sie umbenannt oder verschoben, ordne sie unter Einstellungen → Archiv mit „Archivzustand prüfen“ und „Verschobene Dateien neu verknüpfen“ wieder zu.';

/** Archived documents open their archive copy, or another file only if it still has the stored checksum; others take inbox, then original. */
async function locateFile(services: Services, document: DocRow, archiveRoot: string): Promise<string> {
  const others = [document.stagedPath, document.sourcePath].filter(
    (candidate): candidate is string => candidate !== null && services.scanner.fileExists(candidate),
  );
  if (!document.archiveRelPath) {
    if (others.length === 0) throw new AppError('filesystem_error', 'Die Datei wurde nicht gefunden (verschoben oder gelöscht?).');
    return others[0]!;
  }
  const archived = path.join(archiveRoot, ...document.archiveRelPath.split('/'));
  if (services.scanner.fileExists(archived)) return archived;
  for (const candidate of others) {
    const checksum = await services.pool.run('hashFile', { path: candidate }).catch(() => null);
    if (checksum === document.sha256) return candidate;
  }
  throw new AppError('filesystem_error', ARCHIVE_COPY_MISSING);
}

/** The existing file of a document, only at a location Archivist itself knows: archive, inbox or the original document. */
async function documentPath(services: Services, request: { documentId: string; allowQuarantine?: boolean }): Promise<string> {
  const document = services.documents.getRow(request.documentId);
  // a quarantined file is suspicious: never open it, only reveal it in the file manager
  if (document.status === 'quarantined' && !request.allowQuarantine)
    throw permissionError('Dateien in Quarantäne werden nicht geöffnet. Nutze „Ordner öffnen“, um sie im Dateimanager zu prüfen.');
  const archiveRoot = services.settings.get().archiveRoot;
  const found = await locateFile(services, document, archiveRoot);
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
    'app:openPath': async (input) => openWithHost(host, await documentPath(services, { documentId: input.documentId })),
    'app:revealPath': async (input) => {
      host.revealPath(await documentPath(services, { documentId: input.documentId, allowQuarantine: true }));
      return { ok: true as const };
    },
    'app:openScanFile': async (input) => openWithHost(host, services.scanner.assertOpenable(services.scanner.getFile(input.scanFileId))),

    'settings:get': () => ({ settings: services.settings.get(), hasApiKey: services.secrets.hasApiKey() }),
    'settings:update': (input) => {
      const embeddingBefore = services.settings.get().llm.embeddingModel;
      if (input.archiveRoot !== undefined) {
        if (services.archive.isRootChangeActive())
          throw new AppError('archive_conflict', 'Der Archivordner wird gerade umgestellt. Bitte warte, bis das abgeschlossen ist.');
        services.archiveRoot.assertDirectChangeAllowed(input.archiveRoot);
      }
      const previous = services.settings.get();
      const settings = services.settings.update(input);
      const changes = settingsChanges(previous, settings);
      if (Object.keys(changes.after).length > 0)
        services.audit.log({ action: 'settings.change', actor: 'user', trigger: UI_TRIGGER, confirmed: true, before: changes.before, after: changes.after });
      // vectors of another model are useless for the new one: move the entries over in the background (#173)
      if (settings.llm.embeddingModel !== embeddingBefore) enqueueReembedding(services.jobs);
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
