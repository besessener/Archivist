'use client';

import { useState } from 'react';
import { AlertCircle, CheckCircle2, CircleDashed, CircleHelp, Loader2, MinusCircle, Undo2 } from 'lucide-react';
import { AgentRun, type AgentRunStatus, type AgentStep, type AgentStepOutcome, type AgentUsage } from '@archivist/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/common/states';
import { call } from '@/lib/ipc';
import { useRun } from '@/lib/use-run';
import { cn } from '@/lib/utils';
import type { IpcOutput } from '@archivist/shared';

export type UndoResult = IpcOutput<'agent:undoRun'>;
type UsageLike = Partial<AgentUsage> | undefined;

const decimal = (digits: number) => new Intl.NumberFormat('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Fills in default values (the channel returns input types). */
export function normalizeRun(raw: unknown): AgentRun | null {
  const res = AgentRun.safeParse(raw);
  return res.success ? res.data : null;
}

export function totalTokens(usage: UsageLike): number {
  if (!usage) return 0;
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}

/** „1,2k Tokens“ */
export function formatTokens(n: number): string {
  if (n < 1000) return `${n} Tokens`;
  if (n < 1_000_000) return `${decimal(n < 10_000 ? 1 : 0).format(n / 1000)}k Tokens`;
  return `${decimal(1).format(n / 1_000_000)} Mio. Tokens`;
}

/** „~0,01 $“ (estimate, information only) */
export function formatCost(usd: number | null | undefined): string | null {
  if (usd === null || usd === undefined || Number.isNaN(usd)) return null;
  if (usd > 0 && usd < 0.01) return '< 0,01 $';
  return `~${decimal(2).format(usd)} $`;
}

export function formatDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function runDurationMs(startedAt: string, finishedAt: string | null): number | null {
  if (!finishedAt) return null;
  const d = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  return Number.isNaN(d) ? null : d;
}

/** Discreet usage line: „1,2k Tokens · ~0,01 $ · 12 s“ */
export function usageLine(usage: UsageLike, costUsd: number | null | undefined, durationMs?: number | null): string {
  return [formatTokens(totalTokens(usage)), formatCost(costUsd), formatDuration(durationMs)].filter(Boolean).join(' · ');
}

export const RUN_STATUS: Record<AgentRunStatus, { label: string; variant: 'secondary' | 'success' | 'danger' | 'warning' | 'info' }> = {
  running: { label: 'Läuft', variant: 'info' },
  done: { label: 'Fertig', variant: 'success' },
  ask_user: { label: 'Wartet auf dich', variant: 'warning' },
  limit: { label: 'Grenze erreicht', variant: 'warning' },
  cancelled: { label: 'Abgebrochen', variant: 'secondary' },
  error: { label: 'Fehler', variant: 'danger' },
  refusal: { label: 'Vom Modell abgelehnt', variant: 'danger' },
};

const BACKGROUND_KINDS: Record<string, string> = {
  inbox: 'Eingang sortieren',
  archive_check: 'Archivprüfung',
  links: 'Verknüpfungen',
  nightly: 'Nachtlauf',
  deadline_watch: 'Fristen-Wächter',
  weekly_review: 'Wochenrückblick',
  workflow: 'Ablauf',
};

export function triggerLabel(trigger: string): string {
  if (trigger === 'chat') return 'Chat';
  if (trigger.startsWith('background:')) {
    const kind = trigger.slice('background:'.length);
    return `Hintergrund: ${BACKGROUND_KINDS[kind] ?? kind}`;
  }
  return trigger;
}

const OUTCOME: Record<AgentStepOutcome, { label: string; icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>; cls: string }> = {
  running: { label: 'läuft', icon: Loader2, cls: 'animate-spin text-primary' },
  ok: { label: 'erledigt', icon: CheckCircle2, cls: 'text-success' },
  error: { label: 'fehlgeschlagen', icon: AlertCircle, cls: 'text-destructive' },
  proposed: { label: 'als Vorschlag vorbereitet', icon: CircleDashed, cls: 'text-warning' },
  skipped: { label: 'übersprungen', icon: MinusCircle, cls: 'text-muted-foreground' },
  asked: { label: 'Rückfrage', icon: CircleHelp, cls: 'text-primary' },
};

export function OutcomeIcon({ outcome }: { outcome: AgentStepOutcome }) {
  const o = OUTCOME[outcome];
  const Icon = o.icon;
  return (
    <span className="inline-flex shrink-0" title={o.label}>
      <Icon className={cn('mt-0.5 size-4', o.cls)} aria-hidden />
      <span className="sr-only">{o.label}:</span>
    </span>
  );
}

function argsText(args: unknown): string {
  if (args === undefined) return '';
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return '(nicht darstellbar)';
  }
}

/** One step in plain language, the technical details collapsible. */
export function StepRow({ step, action }: { step: AgentStep; action?: React.ReactNode }) {
  const duration = formatDuration(step.durationMs);
  return (
    <li className="flex items-start gap-2 text-sm" data-testid="agent-step" data-outcome={step.outcome}>
      <OutcomeIcon outcome={step.outcome} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span>{step.label}</span>
          {step.summary && <span className="text-muted-foreground">– {step.summary}</span>}
          {step.risk === 'critical' && <Badge variant="warning">fragt immer</Badge>}
          {duration && <span className="text-[11px] text-muted-foreground">{duration}</span>}
        </div>
        <details className="group mt-0.5">
          <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
            Technische Details
          </summary>
          <div className="mt-1 flex flex-col gap-1 rounded-md bg-muted/50 p-2 text-[11px]">
            <p>
              Werkzeug: <code className="font-mono">{step.tool}</code> · Risiko:{' '}
              {step.risk === 'read' ? 'nur lesen' : step.risk === 'write' ? 'ändert' : 'kritisch'}
            </p>
            {step.args !== undefined && (
              <>
                <p className="text-muted-foreground">Eingabe</p>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono">{argsText(step.args)}</pre>
              </>
            )}
            {step.result && (
              <>
                <p className="text-muted-foreground">Ergebnis</p>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono">{step.result}</pre>
              </>
            )}
          </div>
        </details>
      </div>
      {action}
    </li>
  );
}

export function StepList({ steps, renderAction }: { steps: AgentStep[]; renderAction?: (step: AgentStep) => React.ReactNode }) {
  if (steps.length === 0) return <p className="text-sm text-muted-foreground">Noch keine Schritte.</p>;
  return (
    <ul className="flex flex-col gap-2" data-testid="agent-steps">
      {steps.map((s) => (
        <StepRow key={s.id} step={s} action={renderAction?.(s)} />
      ))}
    </ul>
  );
}

/** Is a step a change that can be undone on its own? */
export const isChange = (s: AgentStep) => s.risk !== 'read' && s.outcome === 'ok';

/** Undo of a whole run or one step, with the result message and the conflicts. */
export function useAgentUndo(runId: string) {
  const { run, busy } = useRun();
  const [result, setResult] = useState<UndoResult | null>(null);
  async function undoRun() {
    const out = await run(() => call('agent:undoRun', { runId }), { errorTitle: 'Rückgängig machen fehlgeschlagen' });
    if (out) setResult(out);
    return out;
  }
  async function undoStep(stepId: string) {
    const out = await run(() => call('agent:undoStep', { runId, stepId }), { errorTitle: 'Rückgängig machen fehlgeschlagen' });
    if (out) setResult(out);
    return out;
  }
  return { undoRun, undoStep, busy, result, clear: () => setResult(null) };
}

export function UndoResultNote({ result }: { result: UndoResult }) {
  return (
    <Notice
      tone={result.failed > 0 || result.conflicts.length > 0 ? 'warning' : 'info'}
      title={result.failed > 0 ? 'Teilweise rückgängig gemacht' : 'Rückgängig gemacht'}
      role="status"
      data-testid="agent-undo-result"
    >
      <p>{result.message}</p>
      {result.conflicts.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-xs">
          {result.conflicts.map((c, i) => (
            <li key={`${i}-${c}`}>{c}</li>
          ))}
        </ul>
      )}
    </Notice>
  );
}

export function UndoStepButton({ onClick, disabled, label }: { onClick: () => void; disabled?: boolean; label: string }) {
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-7 px-2"
      disabled={disabled}
      onClick={onClick}
      aria-label={`Rückgängig: ${label}`}
      data-testid="agent-undo-step"
    >
      <Undo2 aria-hidden /> Rückgängig
    </Button>
  );
}
