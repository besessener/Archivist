'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Square, Undo2 } from 'lucide-react';
import type { AgentRun } from '@archivist/shared';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { call } from '@/lib/ipc';
import { formatDateTime, plural } from '@/lib/format';
import { useRun } from '@/lib/use-run';
import {
  formatCost,
  formatDuration,
  formatTokens,
  isChange,
  RUN_STATUS,
  runDurationMs,
  StepList,
  totalTokens,
  triggerLabel,
  UndoResultNote,
  UndoStepButton,
  useAgentUndo,
} from './run-utils';

export function RunCard({ run, initiallyOpen }: { run: AgentRun; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const undo = useAgentUndo(run.id);
  const { run: exec, busy } = useRun();
  const ref = useRef<HTMLLIElement>(null);
  const status = RUN_STATUS[run.status];
  const changes = run.steps.filter(isChange).length;
  const duration = formatDuration(runDurationMs(run.startedAt, run.finishedAt));
  const cost = formatCost(run.costUsd);
  const panelId = `run-${run.id}-details`;

  useEffect(() => {
    if (initiallyOpen) ref.current?.scrollIntoView({ block: 'start' });
  }, [initiallyOpen]);

  return (
    <li ref={ref} className="rounded-lg border bg-background" data-testid="agent-run" data-run-id={run.id}>
      <button
        type="button"
        className="flex w-full items-start gap-2 p-3 text-left focus-visible:outline-2 focus-visible:outline-ring"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((isOpen) => !isOpen)}
      >
        {open ? <ChevronDown className="mt-0.5 size-4 shrink-0" aria-hidden /> : <ChevronRight className="mt-0.5 size-4 shrink-0" aria-hidden />}
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">{triggerLabel(run.trigger)}</span>
            <Badge variant={status.variant}>{status.label}</Badge>
            <span className="text-xs text-muted-foreground">{formatDateTime(run.startedAt)}</span>
          </span>
          <span className="mt-0.5 block truncate text-sm font-medium">{run.task || '(ohne Auftrag)'}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {[
              [run.provider, run.model].filter(Boolean).join(' / '),
              duration,
              formatTokens(totalTokens(run.usage)),
              cost,
              plural(run.steps.length, ['Schritt', 'Schritte']),
              run.undoable > 0 ? `${plural(run.undoable, ['Änderung', 'Änderungen'])} rückgängig machbar` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
      </button>
      {open && (
        <div id={panelId} className="flex flex-col gap-3 border-t p-3">
          {run.summary && <p className="whitespace-pre-wrap text-sm">{run.summary}</p>}
          {run.error && <p className="text-sm text-destructive">Fehler: {run.error}</p>}
          {run.applied.length > 0 && <p className="text-xs text-muted-foreground">Angewendet: {run.applied.map((applied) => applied.label).join(', ')}</p>}
          <StepList
            steps={run.steps}
            renderAction={(step) =>
              run.undoable > 0 && step.auditIds.length > 0 ? (
                <UndoStepButton label={step.label} disabled={undo.busy} onClick={() => void undo.undoStep(step.id)} />
              ) : null
            }
          />
          {undo.result && <UndoResultNote result={undo.result} />}
          <div className="flex flex-wrap gap-2">
            {run.undoable > 0 && (
              <Button size="sm" variant="outline" disabled={undo.busy} onClick={() => setConfirmOpen(true)} data-testid="agent-run-undo">
                <Undo2 aria-hidden /> Lauf rückgängig
              </Button>
            )}
            {run.status === 'running' && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void exec(() => call('agent:cancelRun', { runId: run.id }), { errorTitle: 'Abbrechen fehlgeschlagen' })}
              >
                <Square aria-hidden /> Stopp
              </Button>
            )}
          </div>
          {changes === 0 && run.undoable === 0 && (
            <p className="text-xs text-muted-foreground">Dieser Lauf hat nichts geändert, was rückgängig zu machen wäre.</p>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Lauf rückgängig machen?"
        description={`${plural(run.undoable, ['Änderung wird', 'Änderungen werden'])} zurückgenommen. Was seitdem anders geändert wurde, wird als Konflikt gemeldet.`}
        confirmLabel="Rückgängig machen"
        onConfirm={async () => {
          const undone = await undo.undoRun();
          if (undone) setConfirmOpen(false);
        }}
      />
    </li>
  );
}
