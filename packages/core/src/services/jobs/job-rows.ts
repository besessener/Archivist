import type { Job } from '@archivist/shared';
import type { jobs } from '../../db/schema';
import type { ArchivistJson } from '../../util/json';
import { newId, nowIso } from '../../util/ids';

export type JobRow = typeof jobs.$inferSelect;

/** A handler may return `{ summary: string }` (besides other data) to describe its outcome in the job history. */
const resultSummary = (result: JobRow['result']): string | null =>
  result && typeof result === 'object' && !Array.isArray(result) && typeof result.summary === 'string' ? result.summary : null;

/** While a job is unfinished, its `result` column holds `{ checkpoint }` (see `JobContext.saveCheckpoint`). */
export const storedCheckpoint = (result: JobRow['result']): unknown =>
  result && typeof result === 'object' && !Array.isArray(result) && 'checkpoint' in result ? result.checkpoint : null;

/** Agent run of a job: in the payload of a file job of a run, in the result of a background run (#304). */
const runIdOf = (row: JobRow): string | null => {
  for (const value of [row.payload, row.result])
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.runId === 'string') return value.runId;
  return null;
};

export const mapJob = (row: JobRow): Job => ({
  id: row.id,
  type: row.type,
  label: row.label,
  status: row.status as Job['status'],
  progress: row.progress,
  progressMessage: row.progressMessage,
  attempts: row.attempts,
  error: row.error,
  summary: resultSummary(row.result),
  runId: runIdOf(row),
  cancelRequested: row.cancelRequested,
  createdAt: row.createdAt,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
});

export function newJobRow(job: { type: string; label: string; payload: unknown; maxAttempts: number }): JobRow {
  return {
    id: newId(),
    type: job.type,
    label: job.label,
    payload: job.payload as ArchivistJson,
    status: 'pending',
    progress: null,
    progressMessage: null,
    attempts: 0,
    maxAttempts: job.maxAttempts,
    error: null,
    result: null,
    cancelRequested: false,
    createdAt: nowIso(),
    startedAt: null,
    finishedAt: null,
  };
}
