import type { ArchiveItemRequest, ArchiveResult } from '@archivist/shared';
import type { ArchiveService, RelocateRequest, RenameRequest } from '../services/archive';
import { isJobCancelled, isJobInterrupted, type JobContext, type JobQueueService } from '../services/jobs';
import type { AgentRunService } from './runs';
import { agentRunScope, currentRun, type AgentRunScope } from './scope';

export const FILE_JOB_TYPE = 'agent.files';
/** Above this many files a move or rename of the agent runs as a job of its own (#304). */
export const FILE_JOB_THRESHOLD = 50;
/** Files per chunk: a stop ends cleanly between two chunks, and a job continues after a restart from the last one. */
export const FILE_CHUNK = 25;

export type FileOp = 'relocate' | 'rename' | 'archive';
type FileItem = RelocateRequest | RenameRequest | ArchiveItemRequest;

/** What the user confirmed for archiving from the inbox (new main categories, moving originals). */
export interface ArchiveConsent {
  approveNewCategories: string[];
  confirmMove: boolean;
}

/** The run id, the step and whether the user asked for it travel with the job: every change it makes carries them. */
export interface FileJobPayload {
  runId: string;
  stepId: string | null;
  explicit: boolean;
  op: FileOp;
  items: FileItem[];
  consent?: ArchiveConsent;
}

export interface FileOpResult extends ArchiveResult {
  /** Files not handled because the run was stopped. */
  stopped: number;
  /** The job that did the work; null when it ran inline (small amounts, background runs). */
  jobId: string | null;
  /** The app quits: the job was interrupted and continues after the next start. */
  resumes: boolean;
}

/** Abort reason of the agent's runs when the app quits: a file job then keeps waiting for the next start instead of being cancelled. */
export class AgentShutdownError extends Error {
  constructor() {
    super('Archivist wird beendet.');
    this.name = 'AgentShutdownError';
  }
}

/** One file operation on a list of items. */
interface FileWork {
  op: FileOp;
  items: FileItem[];
  consent?: ArchiveConsent;
}

const emptyResult = (): ArchiveResult => ({ items: [], success: 0, skipped: 0, failed: 0, conflicts: 0 });

function addResult(into: ArchiveResult, r: ArchiveResult): void {
  into.items.push(...r.items);
  into.success += r.success;
  into.skipped += r.skipped;
  into.failed += r.failed;
  into.conflicts += r.conflicts;
}

/** A tool waiting for its job: the step's scope (audit ids, progress) and how to hand over the result. */
interface Waiting {
  scope: AgentRunScope;
  total: number;
  done: number;
  result: ArchiveResult;
  settle: (r: FileOpResult) => void;
  fail: (err: unknown) => void;
}

export interface AgentFileJobsDeps {
  jobs: JobQueueService;
  archive: ArchiveService;
  runs: AgentRunService;
}

/** Large file operations of the agent as jobs under the run id and step (#304): live progress, „Stopp“ between chunks, resume after restart. */
export class AgentFileJobs {
  private readonly waiting = new Map<string, Waiting>();
  /** Number of files above which an operation runs as a job, and files per chunk (tests lower both). */
  threshold = FILE_JOB_THRESHOLD;
  chunk = FILE_CHUNK;

  private readonly jobs: JobQueueService;
  private readonly archive: ArchiveService;
  private readonly runs: AgentRunService;

  constructor(deps: AgentFileJobsDeps) {
    ({ jobs: this.jobs, archive: this.archive, runs: this.runs } = deps);
  }

  register(): void {
    this.jobs.register<FileJobPayload>(FILE_JOB_TYPE, (job) => this.handle(job), {
      // cancelled before it ran (e.g. still waiting behind other jobs): the tool gets what is done – nothing
      onCancelled: (job) => this.release(job.id, { resumes: false }),
      onFailed: (job, err) => {
        const waiter = this.waiting.get(job.id);
        this.waiting.delete(job.id);
        waiter?.fail(err);
      },
    });
  }

  private release(jobId: string, { resumes }: { resumes: boolean }): void {
    const waiter = this.waiting.get(jobId);
    if (!waiter) return;
    this.waiting.delete(jobId);
    waiter.settle({ ...waiter.result, stopped: waiter.total - waiter.done, jobId, resumes });
  }

  /** In chunks; above the threshold as a job of its own, except in a background run that is a job itself. */
  async run(
    op: FileOp,
    items: FileItem[],
    options: { signal: AbortSignal; label: string; inJob: boolean; report?: (p: number, m: string) => void; consent?: ArchiveConsent },
  ): Promise<FileOpResult> {
    const scope = currentRun();
    if (scope && !options.inJob && items.length > this.threshold) return this.asJob(scope, { op, items, ...options });
    const result = emptyResult();
    let done = 0;
    for (; done < items.length && !options.signal.aborted; done += this.chunk) {
      const chunk = items.slice(done, done + this.chunk);
      addResult(result, await this.apply({ op, items: chunk, consent: options.consent }));
      const handled = Math.min(done + chunk.length, items.length);
      if (items.length > this.chunk) {
        scope?.onProgress?.({ jobId: null, done: handled, total: items.length });
        options.report?.(handled / items.length, `${handled} von ${items.length} Dateien`);
      }
    }
    return { ...result, stopped: Math.max(0, items.length - done), jobId: null, resumes: false };
  }

  private apply({ op, items: chunk, consent }: FileWork): Promise<ArchiveResult> {
    if (op === 'archive')
      return this.archive.execute(chunk as ArchiveItemRequest[], {
        confirmed: true,
        approveNewCategories: consent?.approveNewCategories ?? [],
        confirmMove: consent?.confirmMove ?? false,
        trigger: 'agent',
      });
    return op === 'rename'
      ? this.archive.rename(chunk as RenameRequest[], { confirmed: true, trigger: 'agent' })
      : this.archive.relocate(chunk as RelocateRequest[], { confirmed: true, trigger: 'agent' });
  }

  private asJob(scope: AgentRunScope, work: FileWork & { signal: AbortSignal; label: string }): Promise<FileOpResult> {
    const { op, items, signal, consent } = work;
    return new Promise<FileOpResult>((resolve, reject) => {
      const payload: FileJobPayload = {
        runId: scope.runId,
        stepId: scope.stepId ?? null,
        explicit: scope.explicit,
        op,
        items,
        ...(consent ? { consent } : {}),
      };
      const job = this.jobs.enqueue<FileJobPayload>(FILE_JOB_TYPE, work.label, payload, { maxAttempts: 1 });
      const onAbort = () => {
        // quitting: the queue interrupts the job, it continues after the next start – the run reports what is done
        if (signal.reason instanceof AgentShutdownError) this.release(job.id, { resumes: true });
        else this.jobs.cancel(job.id);
      };
      this.waiting.set(job.id, {
        scope,
        total: items.length,
        done: 0,
        result: emptyResult(),
        settle: (result) => {
          signal.removeEventListener('abort', onAbort);
          resolve(result);
        },
        fail: (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      });
      scope.onProgress?.({ jobId: job.id, done: 0, total: items.length });
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** The waiting tool registers right after `enqueue` returns – the handler may already have started by then. */
  private async waiter(jobId: string): Promise<Waiting | undefined> {
    await Promise.resolve();
    return this.waiting.get(jobId);
  }

  private async handle(job: JobContext<FileJobPayload>): Promise<{ summary: string; runId: string }> {
    const { payload } = job;
    const waiter = await this.waiter(job.id);
    // without a waiting tool (continued after a restart) the job builds the run scope from its payload
    const scope: AgentRunScope = waiter?.scope ?? {
      runId: payload.runId,
      explicit: payload.explicit,
      auditIds: [],
      ...(payload.stepId ? { stepId: payload.stepId } : {}),
    };
    const checkpoint = job.checkpoint as { done: number; result: ArchiveResult } | null;
    const result = checkpoint?.result ?? emptyResult();
    let done = checkpoint?.done ?? 0;
    const sync = () => {
      if (!waiter) return;
      waiter.done = done;
      waiter.result = result;
    };
    sync();
    try {
      while (done < payload.items.length) {
        job.throwIfCancelled();
        const chunk = payload.items.slice(done, done + this.chunk);
        const before = scope.auditIds.length;
        addResult(result, await agentRunScope.run(scope, () => this.apply({ op: payload.op, items: chunk, consent: payload.consent })));
        done += chunk.length;
        if (!waiter && payload.stepId) this.runs.addStepAudit(payload.runId, { stepId: payload.stepId, auditIds: scope.auditIds.slice(before) });
        job.saveCheckpoint({ done, result });
        job.report(done / payload.items.length, `${done} von ${payload.items.length} Dateien`);
        sync();
        scope.onProgress?.({ jobId: job.id, done, total: payload.items.length });
      }
    } catch (err) {
      if (isJobCancelled(err)) this.release(job.id, { resumes: isJobInterrupted(err) });
      throw err;
    }
    this.release(job.id, { resumes: false });
    return { summary: `${result.success} von ${payload.items.length} erledigt`, runId: payload.runId };
  }
}
