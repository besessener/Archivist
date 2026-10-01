'use client';

import { Loader2, RotateCcw, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress, ProgressIndeterminate } from '@/components/ui/progress';
import { call } from '@/lib/ipc';
import { JOB_STATUS_LABELS } from '@/lib/labels';
import { formatDateTime } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import type { JobRecord } from '@/lib/types';
import { cn } from '@/lib/utils';
import { EmptyState, ErrorNote, Loading } from './states';

function statusVariant(s: JobRecord['status']) {
  switch (s) {
    case 'succeeded':
      return 'success' as const;
    case 'failed':
      return 'danger' as const;
    case 'running':
      return 'info' as const;
    default:
      return 'secondary' as const;
  }
}

export function JobRow({ job, onChanged }: { job: JobRecord; onChanged?: () => void }) {
  const { run, busy } = useRun();
  const active = job.status === 'running' || job.status === 'pending';
  return (
    <li className="flex flex-col gap-1.5 rounded-lg border p-3" data-testid="job-row" data-status={job.status}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium" title={job.label}>
            {job.label}
          </p>
          <p className="text-xs text-muted-foreground">
            {formatDateTime(job.startedAt ?? job.createdAt)}
            {job.attempts > 1 ? ` · Versuch ${job.attempts}` : ''}
          </p>
        </div>
        <Badge variant={statusVariant(job.status)}>
          {job.status === 'running' && <Loader2 className="size-3 animate-spin" aria-hidden />}
          {job.cancelRequested && active ? 'Wird abgebrochen' : JOB_STATUS_LABELS[job.status]}
        </Badge>
      </div>
      {job.status === 'running' &&
        (job.progress !== null ? <Progress value={Math.round(job.progress * 100)} aria-label={`Fortschritt ${job.label}`} /> : <ProgressIndeterminate />)}
      {job.progressMessage && active && <p className="text-xs text-muted-foreground">{job.progressMessage}</p>}
      {job.error &&
        (job.status === 'failed' ? (
          <p className="break-words text-xs text-destructive">{job.error}</p>
        ) : (
          // an earlier attempt failed, but the job is not lost: a retry is waiting (or it was cancelled meanwhile)
          <p className="break-words text-xs text-muted-foreground" data-testid="job-last-error">
            Letzter Versuch fehlgeschlagen: {job.error}
          </p>
        ))}
      <div className="flex gap-2">
        {(job.status === 'failed' || job.status === 'cancelled') && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            data-testid="job-retry"
            onClick={async () => {
              await run(() => call('jobs:retry', { id: job.id }), { success: 'Aufgabe wird erneut gestartet.' });
              onChanged?.();
            }}
          >
            <RotateCcw aria-hidden /> Wiederholen
          </Button>
        )}
        {active && !job.cancelRequested && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            data-testid="job-cancel"
            onClick={async () => {
              await run(() => call('jobs:cancel', { id: job.id }));
              onChanged?.();
            }}
          >
            <XCircle aria-hidden /> Abbrechen
          </Button>
        )}
      </div>
    </li>
  );
}

/** Wiederverwendbare Jobliste (Einstellungen und Kopfzeilen-Popover). */
export function JobsList({ limit = 50, className, compact = false }: { limit?: number; className?: string; compact?: boolean }) {
  const { data, loading, error, refetch } = useQuery('jobs:list', { limit }, { scopes: ['jobs'], jobs: true });
  if (error && !data) return <ErrorNote error={error} onRetry={() => void refetch()} />;
  if (!data) return loading ? <Loading /> : null;
  const jobs = compact ? data.slice(0, 8) : data;
  if (jobs.length === 0) {
    return <EmptyState title="Keine Aufgaben" description="Hier erscheinen Analysen, Importe und Suchläufe." className={cn(compact && 'py-6')} />;
  }
  return (
    <ul className={cn('flex flex-col gap-2', className)} data-testid="jobs-list">
      {jobs.map((j) => (
        <JobRow key={j.id} job={j} onChanged={() => void refetch()} />
      ))}
    </ul>
  );
}
