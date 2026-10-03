import { ACTION_EXECUTE_JOB } from '../services/actions';
import { CONTRADICTION_SCAN_JOB } from '../services/contradictions';
import { DOCUMENT_REREAD_JOB } from '../services/documents';
import { isJobCancelled, type JobContext } from '../services/jobs';
import { toErrorInfo } from '../util/errors';
import type { AgentService, BackgroundKind } from '../agent/service';
import type { WiredServices } from './domain-services';

/** Files per automatic analysis job after a scan (the same cap as a manual analysis). */
const AUTO_ANALYZE_BATCH = 500;

type JobServices = WiredServices & { agent: AgentService };

/** A failed attempt keeps the document `analyzing` while a retry follows; only the last one marks it `failed` and notifies. */
function registerDocumentAnalysis({ jobs, documents, notifications, agent }: JobServices): void {
  jobs.register<{ documentId: string; allowLlm: boolean }>('document.analyze', {
    handler: async (job) => {
      const analyzed = await documents.analyze(job.payload.documentId, { allowLlm: job.payload.allowLlm, signal: job.signal, deferFailure: true });
      agent.scheduleInbox();
      return analyzed;
    },
    hooks: {
      onFailed: (job, err) => {
        if (!documents.markAnalysisFailed(job.payload.documentId, err)) return;
        notifications.create({
          title: 'Dateiimport fehlgeschlagen',
          description: err instanceof Error ? err.message : String(err),
          type: 'import_failed',
          priority: 'high',
          affectedEntityIds: [job.payload.documentId],
          proposedActions: [{ label: 'Inbox öffnen', kind: 'navigate', target: '/inbox/' }],
          dedupeKey: `analyze-failed:${job.payload.documentId}:${(Date.now() / 60000) | 0}`,
        });
      },
      // e.g. cancelled while waiting for a retry: the document must not stay in `analyzing`
      onCancelled: (job) => void documents.markAnalysisCancelled(job.payload.documentId),
    },
  });
}

/** Analyses new files automatically only if explicitly enabled and the privacy mode allows it. */
function enqueueAutoAnalysis({ settings, privacy, scanner, jobs }: JobServices): void {
  if (!settings.get().scan.autoAnalyze || privacy.mode() !== 'auto') return;
  // every waiting file (oldest first), in batches like a manual analysis
  const ids = scanner.filesAwaitingAnalysis();
  for (let offset = 0; offset < ids.length; offset += AUTO_ANALYZE_BATCH) {
    const batch = ids.slice(offset, offset + AUTO_ANALYZE_BATCH);
    jobs.enqueue('scanner.analyze', { label: `Analysiere ${batch.length} neue Dateien`, payload: { fileIds: batch, confirmLlm: false } });
  }
}

function registerScannerJobs(services: JobServices): void {
  const { jobs, scanner, agent } = services;
  jobs.register<{ rootId: string | null }>('scanner.scan', {
    handler: async (job) => {
      const summaries = await scanner.runScan(job.payload.rootId, job);
      enqueueAutoAnalysis(services);
      return summaries;
    },
  });
  jobs.register<{ fileIds: string[]; confirmLlm: boolean }>('scanner.analyze', {
    handler: async (job) => {
      const analyzed = await scanner.analyzeFiles(job.payload.fileIds, { confirmLlm: job.payload.confirmLlm, job });
      agent.scheduleInbox();
      return analyzed;
    },
  });
}

/** Re-reads archived documents (#220, #305): one job for the selection, with progress; failures are counted, not fatal. */
async function rereadArchived({ documents, ctx }: JobServices, job: JobContext<{ documentIds: string[] }>) {
  const ids = job.payload.documentIds;
  let done = 0;
  const failed: string[] = [];
  for (const id of ids) {
    job.throwIfCancelled();
    try {
      await documents.rereadArchived(id, { signal: job.signal });
    } catch (err) {
      if (isJobCancelled(err)) throw err;
      failed.push(id);
      ctx.logger.warn('documents', 'Re-reading failed', { documentId: id, error: err });
    }
    done += 1;
    job.report(done / ids.length, `${done} von ${ids.length} Dokumenten neu gelesen`);
  }
  return { reread: done - failed.length, failed };
}

/** Job handlers for documents, the scanner, background agent runs (#313) and the archive check. */
export function registerJobHandlers(services: JobServices): void {
  const { jobs, agent, archive, consistency, contradictions, actions } = services;
  registerDocumentAnalysis(services);
  registerScannerJobs(services);
  jobs.register<{ documentIds: string[] }>(DOCUMENT_REREAD_JOB, { handler: (job) => rereadArchived(services, job) });
  // one job per trigger, cancellable, resumed after a restart
  jobs.register<{ kind: BackgroundKind; docIds?: string[] }>('agent.background', {
    handler: async (job) => {
      const run = await agent.runBackground(job.payload.kind, {
        docIds: job.payload.docIds,
        signal: job.signal,
        report: (p, m) => job.report(p, m),
        resumeFrom: (job.checkpoint as { runId?: string } | null)?.runId ?? null,
        onStart: (runId) => job.saveCheckpoint({ runId }),
      });
      return { summary: run ? `${run.status}: ${run.steps.length} Schritt(e)` : 'nichts zu tun', runId: run?.id ?? null };
    },
  });
  jobs.register<{ actionId: string; overrides: Record<string, unknown> }>(ACTION_EXECUTE_JOB, {
    handler: async (job) => {
      await actions.executeApproved(job.payload.actionId, job.payload.overrides);
      return { summary: actions.get(job.payload.actionId).result ?? 'ausgeführt' };
    },
    hooks: {
      onFailed: (job, error) => actions.markNotExecuted(job.payload.actionId, toErrorInfo(error).message),
      onCancelled: (job) => actions.markNotExecuted(job.payload.actionId, 'Abgebrochen, bevor die Aktion ausgeführt wurde.'),
    },
  });
  jobs.register<Record<string, never>>(CONTRADICTION_SCAN_JOB, {
    handler: async (job) => {
      job.report(null, 'Prüfe Entscheidungen auf Widersprüche');
      const found = await contradictions.scanAll(job.signal);
      return { summary: found.length === 1 ? '1 möglicher Widerspruch' : `${found.length} mögliche Widersprüche` };
    },
  });
  jobs.register<{ trigger?: string }>('consistency.check', {
    handler: async (job) => {
      await archive.cleanupInbox(); // retries inbox copies that were locked right after archiving
      return consistency.run({ trigger: job.payload.trigger ?? 'manual', report: (p, m) => job.report(p, m), signal: job.signal });
    },
  });
}
