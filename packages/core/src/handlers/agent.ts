import fs from 'node:fs/promises';
import path from 'node:path';
import type { Services } from '../create-services';
import { permissionError } from '../util/errors';
import { isInside } from '../util/paths';
import type { HandlerGroup, HostApi } from './types';

/** Only files the agent produced (export folder) may be saved or revealed through the agent channels. */
function exportFile(services: Services, filePath: string): string {
  const directory = path.join(services.paths.root, 'exports');
  const absolute = path.resolve(filePath);
  if (!isInside(directory, absolute) || !services.scanner.fileExists(absolute)) throw permissionError('Diese Datei wurde nicht von Archivist erzeugt.');
  return absolute;
}

function conversationState(services: Services, conversationId?: string) {
  const override = conversationId ? services.chat.agentModeOverride(conversationId) : null;
  return { mode: override ?? services.settings.get().agent.mode, override, activeRun: conversationId ? services.agent.progressFor(conversationId) : null };
}

function runBackground(services: Services, kind: 'inbox' | 'archive_check' | 'links') {
  if (!services.agent.isActive() || !services.llm.canUseInBackground())
    return { jobId: null, message: 'Hintergrund-Läufe brauchen den Agentenmodus, eine KI mit Werkzeugaufrufen und den Datenschutzmodus „automatisch“.' };
  const docIds = kind === 'inbox' ? services.documents.list({ statuses: ['proposed'], limit: 500 }).map((document) => document.id) : [];
  if (kind === 'inbox' && !docIds.length) return { jobId: null, message: 'Im Eingang liegt nichts zum Einsortieren.' };
  const job = services.jobs.enqueue('agent.background', { label: 'Hintergrund-Agent (manuell)', payload: { kind, docIds }, maxAttempts: 1 });
  return { jobId: job.id, message: 'Gestartet.' };
}

/** Agent runs, memory and exports, and the chat. */
export function agentHandlers(services: Services, host: HostApi): HandlerGroup<'agent' | 'chat'> {
  const saveExport = async (filePath: string) => {
    const absolute = exportFile(services, filePath);
    if (!host.saveFile) return { savedTo: null };
    const target = await host.saveFile(path.basename(absolute));
    if (!target) return { savedTo: null };
    await fs.copyFile(absolute, target);
    return { savedTo: target };
  };
  return {
    'agent:capability': () => services.agent.capability(),
    'agent:runs': (input) => services.agentRuns.list(input),
    'agent:run': (input) => services.agentRuns.get(input.id),
    'agent:undoRun': (input) => services.agent.undoRun(input.runId),
    'agent:undoStep': (input) => services.agent.undoStep(input.runId, input.stepId),
    'agent:cancelRun': (input) => ({ cancelled: services.agent.cancelRun(input.runId) }),
    'agent:conversation': (input) => conversationState(services, input.conversationId),
    'agent:setConversationMode': (input) => {
      services.chat.setAgentModeOverride(input.conversationId, input.mode);
      return conversationState(services, input.conversationId);
    },
    'agent:active': () => services.agent.activeRuns(),
    'agent:usage': (input) => services.agentRuns.usageSummary(input.days),
    'agent:runBackground': (input) => runBackground(services, input.kind),
    'agent:memory': (input) => services.memory.list(input.kind),
    'agent:saveMemory': (input) => services.memory.save(input, 'user'),
    'agent:updateMemory': (input) => services.memory.update(input.id, { name: input.name, content: input.content, enabled: input.enabled, data: input.data }),
    'agent:deleteMemory': (input) => {
      services.memory.remove(input.id);
      return { ok: true as const };
    },
    'agent:saveFile': (input) => saveExport(input.path),
    'agent:revealFile': (input) => {
      host.revealPath(exportFile(services, input.path));
      return { ok: true as const };
    },

    'chat:send': (input) => services.chat.send(input.conversationId, input.text),
    'chat:cancel': (input) => ({ cancelled: services.chat.cancel(input.conversationId) }),
    'chat:history': (input) => services.chat.history(input.conversationId, { limit: input.limit, offset: input.offset }),
    'chat:historyCount': (input) => services.chat.historyCount(input.conversationId),
    'chat:conversations': () => services.chat.listConversations(),
    'chat:newConversation': () => services.chat.newConversation(),
    'chat:renameConversation': (input) => services.chat.renameConversation(input.id, input.title),
  };
}
