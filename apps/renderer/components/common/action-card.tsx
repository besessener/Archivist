'use client';

import { useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { call } from '@/lib/ipc';
import { useRun } from '@/lib/use-run';
import type { ActionRecord } from '@/lib/types';
import { ConfidenceBadge } from './confidence';
import { ConfirmDialog } from './confirm-dialog';
import { EntityChip } from './entity-chip';
import { formatDate } from '@/lib/format';

const STATUS: Record<ActionRecord['status'], { label: string; variant: 'secondary' | 'success' | 'danger' | 'warning' | 'info' }> = {
  proposed: { label: 'Wartet auf deine Entscheidung', variant: 'warning' },
  approved: { label: 'Bestätigt', variant: 'info' },
  rejected: { label: 'Abgelehnt', variant: 'secondary' },
  executed: { label: 'Ausgeführt', variant: 'success' },
  failed: { label: 'Fehlgeschlagen', variant: 'danger' },
  withdrawn: { label: 'Nicht mehr aktuell', variant: 'secondary' },
};

type Params = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []);

/** The values a confirmation would store – the label alone can say something else than what is saved (#178). */
function proposedValues(action: ActionRecord): Array<[string, string]> {
  const p = action.proposedParameters as Params;
  const missing = 'nicht angegeben';
  if (action.actionType === 'record_decision') {
    const participants = list(p.participants);
    return [
      ['Entscheidung', str(p.decisionText) ?? missing],
      ['Datum', str(p.decidedAt) ? formatDate(str(p.decidedAt)) : missing],
      ['Beteiligte', participants.length ? participants.join(', ') : missing],
      ['Thema', str(p.topic) ?? missing],
      ...(str(p.project) ? [['Projekt', str(p.project)!] as [string, string]] : []),
      ...(str(p.evidence) ? [['Beleg', `„${str(p.evidence)}“`] as [string, string]] : []),
    ];
  }
  if (action.actionType === 'create_open_item') {
    return [
      ['Punkt', str(p.title) ?? missing],
      ...(str(p.description) ? [['Beschreibung', str(p.description)!] as [string, string]] : []),
      ['Fällig', str(p.dueAt) ? formatDate(str(p.dueAt)) : missing],
      ['Verantwortlich', str(p.responsible) ?? missing],
    ];
  }
  return [];
}

function ProposedValues({ action }: { action: ActionRecord }) {
  const values = proposedValues(action);
  if (values.length === 0) return null;
  const incomplete =
    action.actionType === 'record_decision' && values.some(([k, v]) => ['Datum', 'Beteiligte', 'Thema'].includes(k) && v === 'nicht angegeben');
  return (
    <div className="mt-2 rounded-md bg-muted/50 p-2 text-xs" data-testid="action-values">
      <dl className="grid gap-x-3 gap-y-1 sm:grid-cols-[7rem_1fr]">
        {values.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className={v === 'nicht angegeben' ? 'text-muted-foreground' : undefined}>{v}</dd>
          </div>
        ))}
      </dl>
      {incomplete && <p className="mt-1 text-muted-foreground">Fehlende Angaben: Die Entscheidung wird als Entwurf gespeichert und ich frage danach.</p>}
    </div>
  );
}

/** Card for an action proposal from the agent, with confirm/reject. */
export function ActionCard({ action, onResolved }: { action: ActionRecord; onResolved?: (a: ActionRecord) => void }) {
  const [current, setCurrent] = useState<ActionRecord>(action);
  const [strongOpen, setStrongOpen] = useState(false);
  const { run, busy } = useRun();
  const st = STATUS[current.status];

  async function resolve(decision: 'approve' | 'reject', strongConfirmed = false) {
    const out = await run(
      () =>
        decision === 'approve'
          ? call('actions:resolve', { decision: 'approve', actionId: current.id, confirmed: true, strongConfirmed })
          : call('actions:resolve', { decision: 'reject', actionId: current.id }),
      { success: decision === 'approve' ? 'Aktion bestätigt.' : 'Vorschlag abgelehnt.' },
    );
    if (out) {
      setCurrent(out);
      onResolved?.(out);
    }
    return out;
  }

  return (
    <div className="rounded-lg border bg-background p-3 text-sm" data-testid="action-card" data-status={current.status}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 font-medium">{current.label}</p>
        <Badge variant={st.variant}>{st.label}</Badge>
      </div>
      {current.rationale && <p className="mt-1 text-muted-foreground">{current.rationale}</p>}
      <ProposedValues action={current} />
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <ConfidenceBadge value={current.confidence} />
        {current.requiredConfirmation === 'strong' && <Badge variant="danger">Besonders folgenreich</Badge>}
        {current.affectedEntities.map((e) => (
          <EntityChip key={`${e.type}-${e.id}`} type={e.type} id={e.id} label={e.label} detail={e.detail} />
        ))}
      </div>
      {current.result && <p className="mt-2 text-xs text-muted-foreground">{current.result}</p>}
      {current.status === 'proposed' && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={busy}
            data-testid="action-approve"
            onClick={() => (current.requiredConfirmation === 'strong' ? setStrongOpen(true) : void resolve('approve'))}
          >
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Check aria-hidden />} Bestätigen
          </Button>
          <Button size="sm" variant="outline" disabled={busy} data-testid="action-reject" onClick={() => void resolve('reject')}>
            <X aria-hidden /> Ablehnen
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={strongOpen}
        onOpenChange={setStrongOpen}
        title="Diese Aktion bewusst bestätigen"
        description="Diese Aktion hat weitreichende Folgen. Bitte prüfe die Details."
        confirmLabel="Jetzt ausführen"
        requireCheckbox="Ich habe die Auswirkungen verstanden und möchte diese Aktion ausführen."
        confirmTestId="action-strong-confirm"
        onConfirm={async () => {
          const out = await resolve('approve', true);
          if (out) setStrongOpen(false);
        }}
      >
        <div className="rounded-md border bg-muted/50 p-3 text-sm">
          <p className="font-medium">{current.label}</p>
          <p className="mt-1 text-muted-foreground">{current.rationale}</p>
          {current.affectedEntities.length > 0 && (
            <ul className="mt-2 list-disc pl-5">
              {current.affectedEntities.map((e) => (
                <li key={`${e.type}-${e.id}`}>{e.label}</li>
              ))}
            </ul>
          )}
        </div>
      </ConfirmDialog>
    </div>
  );
}
