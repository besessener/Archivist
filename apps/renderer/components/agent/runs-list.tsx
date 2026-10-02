'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Play, Square, Undo2 } from 'lucide-react';
import type { AgentRun, AgentRunStatus } from '@archivist/shared';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState, ErrorNote, Field, Loading } from '@/components/common/states';
import { Section, SwitchRow } from '@/components/settings/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { call } from '@/lib/ipc';
import { formatDateTime, plural } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import {
  formatCost,
  formatDuration,
  formatTokens,
  isChange,
  normalizeRun,
  RUN_STATUS,
  runDurationMs,
  StepList,
  totalTokens,
  triggerLabel,
  UndoResultNote,
  UndoStepButton,
  useAgentUndo,
} from './run-utils';

const BACKGROUND_JOBS: Array<['inbox' | 'archive_check' | 'links', string]> = [
  ['inbox', 'Eingang sortieren'],
  ['archive_check', 'Archivprüfung auswerten'],
  ['links', 'Verknüpfungen vorschlagen'],
];

function RunCard({ run, initiallyOpen }: { run: AgentRun; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const undo = useAgentUndo(run.id);
  const { run: exec, busy } = useRun();
  const ref = useRef<HTMLLIElement>(null);
  const st = RUN_STATUS[run.status];
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
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown className="mt-0.5 size-4 shrink-0" aria-hidden /> : <ChevronRight className="mt-0.5 size-4 shrink-0" aria-hidden />}
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">{triggerLabel(run.trigger)}</span>
            <Badge variant={st.variant}>{st.label}</Badge>
            <span className="text-xs text-muted-foreground">{formatDateTime(run.startedAt)}</span>
          </span>
          <span className="mt-0.5 block truncate text-sm font-medium">{run.task || '(ohne Auftrag)'}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {[
              [run.provider, run.model].filter(Boolean).join(' / '),
              duration,
              formatTokens(totalTokens(run.usage)),
              cost,
              plural(run.steps.length, 'Schritt', 'Schritte'),
              run.undoable > 0 ? `${plural(run.undoable, 'Änderung', 'Änderungen')} rückgängig machbar` : null,
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
          {run.applied.length > 0 && <p className="text-xs text-muted-foreground">Angewendet: {run.applied.map((a) => a.label).join(', ')}</p>}
          <StepList
            steps={run.steps}
            renderAction={(s) =>
              run.undoable > 0 && s.auditIds.length > 0 ? (
                <UndoStepButton label={s.label} disabled={undo.busy} onClick={() => void undo.undoStep(s.id)} />
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
        description={`${plural(run.undoable, 'Änderung wird', 'Änderungen werden')} zurückgenommen. Was seitdem anders geändert wurde, wird als Konflikt gemeldet.`}
        confirmLabel="Rückgängig machen"
        onConfirm={async () => {
          const out = await undo.undoRun();
          if (out) setConfirmOpen(false);
        }}
      />
    </li>
  );
}

/**
 * The fixed link methods (#279, #290, #313): how many entries have no link yet, and the retroactive run – local, without
 * LLM, only proposals. The agent uses the same functions as tools.
 */
function LinkMethodsSection() {
  const unlinked = useQuery('links:unlinked', { limit: 1, offset: 0 }, { scopes: ['knowledge'] });
  const settings = useQuery('settings:get', {}, { scopes: ['settings'] });
  const { run, busy } = useRun();
  const [message, setMessage] = useState<string | null>(null);
  const total = unlinked.data?.total;
  const links = settings.data?.settings.links;
  const saveLinks = async (patch: { autoPropose?: boolean; maxProposalsPerEntry?: number }) => {
    const out = await run(() => call('settings:update', { links: patch }), { errorTitle: 'Speichern fehlgeschlagen' });
    if (out) void settings.refetch();
  };
  return (
    <Section
      title="Verknüpfungen vorschlagen"
      description="Geht das ganze Archiv durch und schlägt ähnliche Einträge als Verknüpfung sowie neue Themen für ähnliche Einträge ohne Thema vor. Läuft lokal; bestätigt wird nur, was du übernimmst."
    >
      {links && (
        <>
          <SwitchRow
            label="Verknüpfungen automatisch vorschlagen"
            hint="Nach jedem neuen oder geänderten Eintrag sucht Archivist lokal nach ähnlichen Einträgen; Einträge aus derselben Nachricht oder demselben Dokument gehören zusammen. Alles bleibt ein Vorschlag."
          >
            <Switch
              checked={links.autoPropose}
              disabled={busy}
              onCheckedChange={(v) => void saveLinks({ autoPropose: v })}
              aria-label="Verknüpfungen automatisch vorschlagen"
              data-testid="links-auto-propose"
            />
          </SwitchRow>
          <Field label="Höchstens offene Vorschläge je Eintrag" htmlFor="links-max-proposals">
            <Select
              id="links-max-proposals"
              className="w-24"
              value={String(links.maxProposalsPerEntry)}
              disabled={busy}
              onChange={(e) => void saveLinks({ maxProposalsPerEntry: Number(e.target.value) })}
              data-testid="links-max-proposals"
            >
              {[1, 2, 3, 5, 10].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
        </>
      )}
      <p className="text-sm" data-testid="links-unlinked-count">
        {total === undefined
          ? 'Zähle Einträge ohne Verknüpfung …'
          : total === 0
            ? 'Alle Einträge sind verknüpft.'
            : `${plural(total, 'Eintrag', 'Einträge')} ohne Verknüpfung.`}
      </p>
      <div>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          data-testid="links-start-run"
          onClick={async () => {
            const out = await run(() => call('links:startRun', {}), { errorTitle: 'Start fehlgeschlagen' });
            if (out) setMessage('Gestartet. Der Fortschritt erscheint unter „Verarbeitung“, das Ergebnis als ein Hinweis in der Glocke.');
          }}
        >
          <Play aria-hidden /> Verknüpfungslauf starten
        </Button>
      </div>
      {message && (
        <p className="text-xs text-muted-foreground" role="status">
          {message}
        </p>
      )}
    </Section>
  );
}

/** Agent runs with filter, steps, undo and manual start of background runs (#299). */
export function AgentRunsList({ focusRunId }: { focusRunId?: string | null }) {
  const [trigger, setTrigger] = useState<'' | 'chat' | 'background'>('');
  const [status, setStatus] = useState<'' | AgentRunStatus>('');
  const { run, busy } = useRun();
  const [bgMessage, setBgMessage] = useState<string | null>(null);
  const q = useQuery('agent:runs', { limit: 200, ...(trigger ? { trigger } : {}), ...(status ? { status } : {}) }, { scopes: ['agent'] });
  const runs = useMemo(() => (q.data ?? []).map(normalizeRun).filter((r): r is AgentRun => r !== null), [q.data]);

  return (
    <div className="flex flex-col gap-4">
      <Section title="Hintergrund-Lauf starten" description="Startet einen Lauf sofort, unabhängig vom Zeitplan.">
        <div className="flex flex-wrap gap-2">
          {BACKGROUND_JOBS.map(([kind, label]) => (
            <Button
              key={kind}
              variant="outline"
              size="sm"
              disabled={busy}
              data-testid={`agent-run-bg-${kind}`}
              onClick={async () => {
                const out = await run(() => call('agent:runBackground', { kind }), { errorTitle: 'Start fehlgeschlagen' });
                if (out) {
                  setBgMessage(out.message);
                  void q.refetch();
                }
              }}
            >
              <Play aria-hidden /> {label}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground" role="status" data-testid="agent-run-bg-message">
          {bgMessage ?? 'Der Fortschritt erscheint unter „Verarbeitung“, das Ergebnis in der Liste unten.'}
        </p>
      </Section>

      <LinkMethodsSection />

      <Section title="Agentenläufe" description="Was Archivist als Agent getan hat – im Chat und im Hintergrund. Jede Änderung ist protokolliert.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Auslöser" htmlFor="runs-trigger">
            <Select id="runs-trigger" value={trigger} onChange={(e) => setTrigger(e.target.value as typeof trigger)} data-testid="agent-runs-trigger">
              <option value="">alle</option>
              <option value="chat">Chat</option>
              <option value="background">Hintergrund</option>
            </Select>
          </Field>
          <Field label="Status" htmlFor="runs-status">
            <Select id="runs-status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} data-testid="agent-runs-status">
              <option value="">alle</option>
              {(Object.keys(RUN_STATUS) as AgentRunStatus[]).map((s) => (
                <option key={s} value={s}>
                  {RUN_STATUS[s].label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {q.error && <ErrorNote error={q.error} onRetry={() => void q.refetch()} />}
        {!q.data && q.loading && <Loading />}
        {q.data && runs.length === 0 && <EmptyState title="Keine Agentenläufe" description="Sobald Archivist als Agent arbeitet, erscheinen die Läufe hier." />}
        {runs.length > 0 && (
          <ul className="flex flex-col gap-2" data-testid="agent-runs">
            {runs.map((r) => (
              <RunCard key={r.id} run={r} initiallyOpen={r.id === focusRunId} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
