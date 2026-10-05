'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Download, FolderOpen, Undo2 } from 'lucide-react';
import type { AgentStep } from '@archivist/shared';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { Button } from '@/components/ui/button';
import { call } from '@/lib/ipc';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import { isChange, normalizeRun, OutcomeIcon, runDurationMs, StepList, UndoResultNote, UndoStepButton, useAgentUndo, usageLine } from './run-utils';

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function Group({ title, steps, renderAction }: { title: string; steps: AgentStep[]; renderAction?: (s: AgentStep) => React.ReactNode }) {
  if (steps.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <ul className="mt-1 flex flex-col gap-1">
        {steps.map((s) => (
          <li key={s.id} className="flex items-start gap-2 text-sm">
            <OutcomeIcon outcome={s.outcome} />
            <span className="min-w-0 flex-1">
              {s.label}
              {s.summary && <span className="text-muted-foreground"> – {s.summary}</span>}
            </span>
            {renderAction?.(s)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Compact summary of the run behind a chat answer (#300): changes, proposals, failures, undo, usage. */
export function RunSummary({ runId }: { runId: string }) {
  const query = useQuery('agent:run', { id: runId }, { scopes: ['agent'] });
  const undo = useAgentUndo(runId);
  const { run } = useRun();
  const [open, setOpen] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const r = useMemo(() => (query.data ? normalizeRun(query.data) : null), [query.data]);
  if (!r) return null;

  const changed = r.steps.filter(isChange);
  const proposed = r.steps.filter((s) => s.outcome === 'proposed');
  const failed = r.steps.filter((s) => s.outcome === 'error');
  const undoable = r.undoable > 0;
  const stepAction = (s: AgentStep) =>
    undoable && s.auditIds.length > 0 ? <UndoStepButton label={s.label} disabled={undo.busy} onClick={() => void undo.undoStep(s.id)} /> : null;

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-2.5" data-testid="agent-run-summary">
      <Group title="Geändert" steps={changed} renderAction={stepAction} />
      <Group title="Vorgeschlagen" steps={proposed} />
      <Group title="Fehlgeschlagen" steps={failed} />
      {r.files.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground">Erzeugte Dateien</p>
          <ul className="mt-1 flex flex-col gap-1">
            {r.files.map((f) => (
              <li key={f} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="min-w-0 truncate">{fileName(f)}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2"
                  aria-label={`${fileName(f)} speichern unter`}
                  onClick={() => void run(() => call('agent:saveFile', { path: f }), { errorTitle: 'Speichern fehlgeschlagen' })}
                >
                  <Download aria-hidden /> Speichern
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2"
                  aria-label={`${fileName(f)} im Ordner zeigen`}
                  onClick={() => void run(() => call('agent:revealFile', { path: f }), { errorTitle: 'Ordner konnte nicht geöffnet werden' })}
                >
                  <FolderOpen aria-hidden /> Im Ordner zeigen
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {r.applied.length > 0 && <p className="text-xs text-muted-foreground">Angewendet: {r.applied.map((a) => a.label).join(', ')}</p>}
      {undo.result && <UndoResultNote result={undo.result} />}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" className="h-7 px-2" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="agent-run-details">
          {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />} Details ({r.steps.length} Schritte)
        </Button>
        {undoable && (
          <Button size="sm" variant="outline" className="h-7 px-2" disabled={undo.busy} onClick={() => setConfirmOpen(true)} data-testid="agent-undo-run">
            <Undo2 aria-hidden /> Rückgängig
          </Button>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground" data-testid="agent-run-usage">
          {usageLine({ usage: r.usage, costUsd: r.costUsd, durationMs: runDurationMs(r.startedAt, r.finishedAt) })}
        </span>
      </div>
      {open && <StepList steps={r.steps} renderAction={stepAction} />}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Alle Änderungen dieses Laufs rückgängig machen?"
        description={`${r.undoable} Änderung(en) werden zurückgenommen. Was seitdem anders geändert wurde, wird als Konflikt gemeldet und nicht überschrieben.`}
        confirmLabel="Rückgängig machen"
        confirmTestId="agent-undo-run-confirm"
        onConfirm={async () => {
          const out = await undo.undoRun();
          if (out) setConfirmOpen(false);
        }}
      />
    </div>
  );
}
