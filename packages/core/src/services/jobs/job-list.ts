import type { Job } from '@archivist/shared';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { jobs } from '../../db/schema';

/** The columns of a list view: the payload and the result (checkpoints can be megabytes) stay in the database, only the few fields the list shows are extracted. */
const listColumns = {
  id: jobs.id,
  type: jobs.type,
  label: jobs.label,
  status: jobs.status,
  progress: jobs.progress,
  progressMessage: jobs.progressMessage,
  attempts: jobs.attempts,
  error: jobs.error,
  cancelRequested: jobs.cancelRequested,
  createdAt: jobs.createdAt,
  startedAt: jobs.startedAt,
  finishedAt: jobs.finishedAt,
  summary: sql<unknown>`json_extract(${jobs.result}, '$.summary')`,
  payloadRunId: sql<unknown>`json_extract(${jobs.payload}, '$.runId')`,
  resultRunId: sql<unknown>`json_extract(${jobs.result}, '$.runId')`,
};

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

type ListedRow = Omit<Job, 'summary' | 'runId' | 'status'> & { status: string; summary: unknown; payloadRunId: unknown; resultRunId: unknown };

const mapListedJob = (row: ListedRow): Job => ({
  id: row.id,
  type: row.type,
  label: row.label,
  status: row.status as Job['status'],
  progress: row.progress,
  progressMessage: row.progressMessage,
  attempts: row.attempts,
  error: row.error,
  summary: textOrNull(row.summary),
  runId: textOrNull(row.payloadRunId) ?? textOrNull(row.resultRunId),
  cancelRequested: row.cancelRequested,
  createdAt: row.createdAt,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
});

/** Jobs that need attention come first in this order, so a running one is never pushed out by newer failures. */
const ATTENTION_ORDER = ['running', 'pending', 'failed'] as const;

const attentionRank = sql.join(
  [sql`case ${jobs.status}`, ...ATTENTION_ORDER.map((status, rank) => sql`when ${status} then ${rank}`), sql`else ${ATTENTION_ORDER.length} end`],
  sql` `,
);

export interface JobListFilter {
  type?: string;
  activeOnly?: boolean;
}

export function listJobs(db: AppContext['database']['db'], query: JobListFilter & { limit: number }): Job[] {
  const conditions = [...(query.type ? [eq(jobs.type, query.type)] : []), ...(query.activeOnly ? [inArray(jobs.status, ['pending', 'running'])] : [])];
  return db
    .select(listColumns)
    .from(jobs)
    .where(and(...conditions))
    .orderBy(attentionRank, desc(jobs.createdAt))
    .limit(query.limit)
    .all()
    .map(mapListedJob);
}
