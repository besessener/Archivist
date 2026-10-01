import path from 'node:path';
import { ipcContract, type AppStatus, type IpcChannel, type IpcOutput, type IpcParsedInput, type Result } from '@archivist/shared';
import type { Services } from './create-services';
import { AppError, permissionError, toErrorInfo } from './util/errors';
import { isInside } from './util/paths';

/** Betriebssystem-nahe Funktionen, die nur der Electron-Main-Prozess bereitstellen kann. */
export interface HostApi {
  version: string;
  platform: string;
  selectDirectory(title?: string): Promise<string | null>;
  /** Öffnet eine Datei mit dem Standardprogramm; liefert einen Fehlertext oder ''. */
  openPath(absPath: string): Promise<string>;
  revealPath(absPath: string): void;
  secretBackend?: () => { available: boolean; backend: string };
}

type HandlerMap = { [C in IpcChannel]: (input: IpcParsedInput<C>) => Promise<IpcOutput<C>> | IpcOutput<C> };

/** Implementiert jeden IPC-Kanal ausschließlich über den Service-Layer. */
export function createHandlers(s: Services, host: HostApi): HandlerMap {
  const trigger = 'ui';
  const settingsPayload = () => ({ settings: s.settings.get(), hasApiKey: s.secrets.hasApiKey() });

  const status = (): AppStatus => {
    const settings = s.settings.get();
    const llm = s.llm.status();
    const counts = s.jobs.counts();
    const sec = host.secretBackend ? host.secretBackend() : s.secrets.status();
    return {
      version: host.version,
      dataRoot: s.paths.root,
      archiveRoot: settings.archiveRoot,
      platform: host.platform,
      setupCompleted: settings.setupCompleted,
      llm: {
        configured: s.llm.isConfigured(),
        hasApiKey: s.secrets.hasApiKey(),
        status: llm.state,
        lastError: llm.lastError,
        lastCheckedAt: llm.lastCheckedAt,
      },
      secretStorage: sec,
      jobs: counts,
      unreadNotifications: s.notifications.unreadCount(),
      openInsights: s.insights.openCount(),
      services: [
        { name: 'Datenbank', status: s.migration.upToDate ? 'ok' : 'degraded', detail: `Migrationen ${s.migration.applied}/${s.migration.total}` },
        {
          name: 'Job-Queue',
          status: counts.failed > 0 ? 'degraded' : 'ok',
          detail: `${counts.pending} wartend, ${counts.running} laufend, ${counts.failed} fehlgeschlagen`,
        },
        { name: 'Worker', status: 'ok', detail: s.pool.mode === 'thread' ? 'Worker-Threads aktiv' : 'Inline-Modus' },
        { name: 'Sicherer Speicher', status: sec.available ? 'ok' : 'error', detail: sec.backend },
      ],
    };
  };

  const documentPath = (id: string): string => {
    const d = s.documents.getRow(id);
    const candidates = [d.archiveRelPath ? path.join(s.settings.get().archiveRoot, ...d.archiveRelPath.split('/')) : null, d.stagedPath, d.sourcePath].filter(
      (x): x is string => Boolean(x),
    );
    const found = candidates.find((c) => s.scanner.fileExists(c));
    if (!found) throw new AppError('filesystem_error', 'Die Datei wurde nicht gefunden (verschoben oder gelöscht?).');
    // nur Orte öffnen, die Archivist selbst kennt: Archiv, Eingang oder das ursprüngliche Dokument
    const allowed = [s.settings.get().archiveRoot, s.paths.inbox].some((root) => isInside(root, found)) || found === d.sourcePath;
    if (!allowed) throw permissionError('Dieser Pfad darf nicht geöffnet werden.');
    return found;
  };

  const h: HandlerMap = {
    'app:getStatus': () => status(),
    'app:completeSetup': () => {
      s.settings.update({ setupCompleted: true });
      return { ok: true as const };
    },
    'app:selectDirectory': async (i) => ({ path: await host.selectDirectory(i.title) }),
    'app:openPath': async (i) => {
      const err = await host.openPath(documentPath(i.documentId));
      if (err) throw new AppError('filesystem_error', 'Die Datei konnte nicht geöffnet werden.', { details: err });
      return { ok: true as const };
    },
    'app:revealPath': (i) => {
      host.revealPath(documentPath(i.documentId));
      return { ok: true as const };
    },
    'app:openScanFile': async (i) => {
      const err = await host.openPath(s.scanner.assertOpenable(s.scanner.getFile(i.scanFileId)));
      if (err) throw new AppError('filesystem_error', 'Die Datei konnte nicht geöffnet werden.', { details: err });
      return { ok: true as const };
    },

    'settings:get': () => settingsPayload(),
    'settings:update': (i) => ({ settings: s.settings.update(i) }),
    'settings:setApiKey': (i) => {
      s.secrets.setApiKey(i.apiKey);
      s.events.changed('settings', 'status');
      return { ok: true as const };
    },
    'settings:clearApiKey': () => {
      s.secrets.clear();
      s.events.changed('settings', 'status');
      return { ok: true as const };
    },

    'llm:testConnection': (i) => s.llm.testConnection({ baseUrl: i.baseUrl, model: i.model, apiKey: i.apiKey }),
    'llm:transmissions': (i) => s.llm.listTransmissions(i.limit),

    'chat:send': (i) => s.chat.send(i.conversationId, i.text),
    'chat:history': (i) => s.chat.history(i.conversationId),
    'chat:conversations': () => s.chat.listConversations(),
    'chat:newConversation': () => s.chat.newConversation(),
    'chat:renameConversation': (i) => s.chat.renameConversation(i.id, i.title),

    'actions:list': (i) => s.actions.list(i.status),
    'actions:resolve': (i) =>
      i.decision === 'approve'
        ? s.actions.resolve(i.actionId, 'approve', { confirmed: i.confirmed, strongConfirmed: i.strongConfirmed, overrides: i.parameterOverrides })
        : s.actions.resolve(i.actionId, 'reject', {}),

    'decisions:create': async (i) => {
      const d = s.decisions.create(i, { actor: 'user', trigger });
      if (d.status === 'active') await s.contradictions.checkDecision(d.id); // Widersprüche nur als Hinweis
      return d;
    },
    'decisions:update': async (i) => {
      const d = s.decisions.update(i.id, i.patch, { trigger });
      if (d.status === 'active') await s.contradictions.checkDecision(d.id);
      return d;
    },
    'decisions:get': (i) => s.decisions.get(i.id),
    'decisions:list': (i) => s.decisions.list(i),
    'decisions:search': (i) => s.decisions.searchDecisions(i.query, i.limit),
    'decisions:proposeSupersede': (i) => {
      const o = s.decisions.get(i.oldDecisionId);
      const n = s.decisions.get(i.newDecisionId);
      return s.actions.propose({
        actionType: 'supersede_decision',
        label: `„${o.title}“ durch „${n.title}“ ersetzen`,
        rationale: 'Vom Benutzer vorgeschlagen.',
        confidence: 0.9,
        affectedEntities: [
          { type: 'decision', id: o.id, label: o.title },
          { type: 'decision', id: n.id, label: n.title },
        ],
        requiredConfirmation: 'confirm',
        proposedParameters: { oldDecisionId: o.id, newDecisionId: n.id },
      });
    },

    'documents:import': async (i) => s.documents.importPaths(i.paths),
    'documents:list': (i) => s.documents.list(i),
    'documents:get': (i) => s.documents.get(i.id),
    'documents:classify': (i) => ({ jobId: s.documents.enqueueAnalysis(i.documentId, i.allowLlm) }),
    'documents:previewArchive': (i) => s.archive.preview(i.items),
    'documents:archive': (i) =>
      s.archive.execute(i.items, { confirmed: i.confirmed, approveNewCategories: i.approveNewCategories, confirmMove: i.confirmMove, trigger: 'manual' }),
    'documents:undoArchive': (i) => s.undo.undo(i.auditId),
    'documents:updateMetadata': (i) =>
      s.documents.updateMetadata(i.id, { title: i.title, topic: i.topic, project: i.project, tags: i.tags, persons: i.persons }, i.confirmed),
    'documents:ignore': (i) => s.documents.ignore(i.id),
    'documents:forTopic': (i) => {
      const e = s.graph.getEntity(i.topicId);
      return s.documents.list({ [e?.type === 'project' ? 'projectId' : 'topicId']: i.topicId, limit: 500 });
    },
    'documents:setLlmExcluded': (i) => s.documents.setLlmExcluded(i.id, i.excluded),

    'scanner:addDirectory': (i) => s.scanner.addDirectory(i.path, i.recursive),
    'scanner:removeDirectory': (i) => {
      s.scanner.removeDirectory(i.id);
      return { ok: true as const };
    },
    'scanner:updateDirectory': (i) => {
      const { id, ...patch } = i;
      return s.scanner.updateDirectory(id, patch);
    },
    'scanner:listDirectories': () => s.scanner.listDirectories(),
    'scanner:start': (i) => ({ jobId: s.scanner.startScan(i.rootId).id }),
    'scanner:getResults': (i) => s.scanner.getResults(i),
    'scanner:analyze': (i) => ({
      jobId: s.jobs.enqueue('scanner.analyze', `Analysiere ${i.fileIds.length} Datei(en)`, { fileIds: i.fileIds, confirmLlm: i.confirmLlm }, { maxAttempts: 1 })
        .id,
    }),
    'scanner:proposals': () => s.scanner.proposals(),
    'scanner:exclude': (i) => s.scanner.exclude(i.kind, i.path),
    'scanner:listExclusions': () => s.scanner.listExclusions(),
    'scanner:removeExclusion': (i) => {
      s.scanner.removeExclusion(i.id);
      return { ok: true as const };
    },

    'jobs:list': (i) => s.jobs.list(i.limit),
    'jobs:retry': (i) => s.jobs.retry(i.id),
    'jobs:cancel': (i) => s.jobs.cancel(i.id),

    'notifications:list': (i) => s.notifications.list(i),
    'notifications:markRead': (i) => {
      s.notifications.markRead(i.ids);
      return { ok: true as const };
    },
    'notifications:resolve': (i) => s.notifications.resolve(i.id),
    'notifications:snooze': (i) => {
      const n = s.notifications.get(i.id);
      s.notifications.resolve(i.id);
      return s.reminders.create({ targetType: 'notification', targetId: i.id, title: n.title, remindAt: i.remindAt });
    },

    'insights:list': (i) => s.insights.list(i.status),
    'insights:respond': async (i) => {
      if (i.response === 'accept') return s.insights.accept(i.id, { strongConfirmed: i.strongConfirmed });
      if (i.response === 'reject') return s.insights.reject(i.id);
      return s.insights.remindLater(i.id, i.remindAt);
    },
    'consistency:run': () => ({ jobId: s.enqueueConsistency('manual').id }),
    'contradictions:list': (i) => s.contradictions.list(i.status),
    'contradictions:resolve': (i) =>
      s.contradictions.resolve(i.id, i.resolution, {
        confirmed: i.confirmed,
        supersedeOldDecisionId: i.supersedeOldDecisionId,
        supersedeNewDecisionId: i.supersedeNewDecisionId,
      }),

    'reminders:create': (i) => s.reminders.create(i),
    'reminders:snooze': (i) => s.reminders.snooze(i.id, i.remindAt),
    'reminders:dismiss': (i) => {
      s.reminders.dismiss(i.id);
      return { ok: true as const };
    },
    'reminders:list': (i) => s.reminders.list(i.status),

    'openItems:list': (i) => s.openItems.list(i),
    'openItems:create': (i) => s.openItems.create(i, { actor: 'user', trigger }),
    'openItems:update': (i) => s.openItems.update(i.id, i.patch),
    'openItems:close': (i) => s.openItems.close(i.id, i.status, { confirmed: i.confirmed, trigger }),
    'openItems:solutionPreview': (i) => s.solutions.preview(i.id),
    'openItems:generateSolution': (i) => s.solutions.generate(i.id, { confirmed: i.confirmed }),
    'openItems:cancelSolution': (i) => ({ cancelled: s.solutions.cancel(i.id) }),
    'openItems:applySolution': (i) => s.solutions.apply(i),

    'knowledge:listEntities': (i) => s.graph.listEntities(i),
    'knowledge:getEntity': (i) => s.graph.getDetail(i.id),
    'knowledge:resolveRelation': (i) => {
      s.graph.setRelationStatus(i.relationId, i.status);
      s.audit.log({ action: `relation.${i.status}`, actor: 'user', trigger, confirmed: true, entityIds: [i.relationId] });
      return { ok: true as const };
    },
    'knowledge:createEntity': async (i) => {
      if (i.type === 'event') {
        const { event, created } = s.eventRecords.createUnlessExists(i, { actor: 'user', trigger });
        const entity = s.graph.getEntity(event.id) ?? {
          id: event.id,
          type: 'event' as const,
          name: event.title,
          description: event.description,
          aliases: [],
          createdAt: event.createdAt,
          updatedAt: event.updatedAt,
        };
        return { entity, created };
      }
      if (i.type === 'note') {
        const { note, created } = await s.notes.createUnlessExists({ title: i.name, content: i.description?.trim() || i.name });
        if (created) s.audit.log({ action: 'note.create', actor: 'user', trigger, confirmed: true, entityIds: [note.id], after: { title: note.name } });
        return { entity: note, created };
      }
      // a merged-away name (alias) also counts as existing
      const existing = s.graph.findByNameOrAlias(i.type, i.name);
      if (existing) return { entity: existing, created: false };
      const entity = s.graph.ensureEntity(i.type, i.name, i.description?.trim() || null);
      s.audit.log({ action: `${i.type}.create`, actor: 'user', trigger, confirmed: true, entityIds: [entity.id], after: { name: entity.name } });
      return { entity, created: true };
    },
    'knowledge:proposeMerge': (i) => {
      const a = s.graph.getEntity(i.sourceTopicId);
      const b = s.graph.getEntity(i.targetTopicId);
      if (!a || !b) throw new AppError('validation_error', 'Thema nicht gefunden.');
      return s.actions.propose({
        actionType: 'merge_topics',
        label: `Themen „${a.name}“ in „${b.name}“ zusammenführen`,
        rationale: 'Vom Benutzer vorgeschlagen.',
        confidence: 0.9,
        affectedEntities: [
          { type: 'topic', id: a.id, label: a.name },
          { type: 'topic', id: b.id, label: b.name },
        ],
        requiredConfirmation: 'confirm',
        proposedParameters: { sourceTopicId: a.id, targetTopicId: b.id },
      });
    },

    'events:list': (i) => s.eventRecords.list(i),
    'events:create': (i) => s.eventRecords.create(i),
    'events:update': (i) => s.eventRecords.update(i.id, i.patch),
    'events:delete': (i) => {
      s.eventRecords.delete(i.id, { confirmed: i.confirmed });
      return { ok: true as const };
    },
    'timeline:get': (i) => s.timeline.get(i),
    'search:global': (i) => s.search.search(i.query, { types: i.types, limit: i.limit }),

    'audit:list': (i) => s.audit.list(i.limit, i.onlyUndoable),
    'audit:undo': (i) => s.undo.undo(i.auditId),

    'categories:list': () => s.categories.list(),
    'categories:create': (i) => s.archive.createCategory(i.path, i.confirmed),
    'backup:create': (i) => s.backup.create(i.includeArchive),
    'backup:list': () => s.backup.list(),
    'archive:verify': () => s.archive.verify(),
  };
  return h;
}

export type IpcDispatcher = (channel: string, rawInput: unknown) => Promise<Result<unknown>>;

/**
 * Zentrale Eintrittsstelle für IPC: Kanal-Allowlist, Zod-Validierung von Ein- und Ausgabe,
 * einheitliche Fehlerantworten. Wird vom Electron-Main-Prozess (und in Tests) verwendet.
 */
export function createIpcDispatcher(handlers: HandlerMap, onError?: (channel: string, err: unknown) => void): IpcDispatcher {
  return async (channel, rawInput) => {
    if (!Object.prototype.hasOwnProperty.call(ipcContract, channel)) {
      return { ok: false, error: { category: 'permission_error', message: `Unbekannter oder nicht erlaubter IPC-Kanal: ${channel}`, retryable: false } };
    }
    const c = channel as IpcChannel;
    const spec = ipcContract[c];
    const parsed = spec.input.safeParse(rawInput ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          category: 'validation_error',
          message: 'Ungültige Eingabe.',
          retryable: false,
          details: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
        },
      };
    }
    try {
      const fn = handlers[c] as (input: unknown) => unknown;
      const out = await fn(parsed.data);
      const checked = spec.output.safeParse(out);
      if (!checked.success) {
        onError?.(channel, checked.error);
        return {
          ok: false,
          error: {
            category: 'validation_error',
            message: 'Interne Antwort entsprach nicht dem Schema.',
            retryable: false,
            details: checked.error.issues
              .slice(0, 5)
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join('; '),
          },
        };
      }
      return { ok: true, data: checked.data };
    } catch (err) {
      onError?.(channel, err);
      return { ok: false, error: toErrorInfo(err) };
    }
  };
}
