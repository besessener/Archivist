import { z } from 'zod';
import { Id, IsoDate } from './common';

export const JobStatus = z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled']);
export type JobStatus = z.infer<typeof JobStatus>;
export const Job = z.object({
  id: Id,
  type: z.string(),
  label: z.string(),
  status: JobStatus,
  progress: z.number().nullable(),
  progressMessage: z.string().nullable(),
  attempts: z.number(),
  error: z.string().nullable(),
  /** Short outcome of a finished job for the job history (from a handler result with a `summary` string). */
  summary: z.string().nullable(),
  /** Agent run the job belongs to (file jobs of a run, background runs); the job list links to it (#304). */
  runId: z.string().nullable().default(null),
  cancelRequested: z.boolean(),
  createdAt: IsoDate,
  startedAt: IsoDate.nullable(),
  finishedAt: IsoDate.nullable(),
});
export type Job = z.infer<typeof Job>;
