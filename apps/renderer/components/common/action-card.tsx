'use client';

import { useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
  if (action.actionType === 'close_open_item') {
    return str(p.resolutionNote) ? [[p.status === 'dismissed' ? 'Warum verworfen' : 'Lösung', str(p.resolutionNote)!]] : [];
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

interface BatchItem {
  label: string;
  reason: string;
  risk: 'read' | 'write' | 'critical';
}

function batchItems(action: ActionRecord): BatchItem[] {
  if (action.actionType !== 'agent_batch') return [];
  const items = (action.proposedParameters as Params).items;
  if (!Array.isArray(items)) return [];
  return items.map((it) => {
    const o = (it && typeof it === 'object' ? it : {}) as Params;
    const risk = o.risk === 'critical' || o.risk === 'read' ? o.risk : 'write';
    return { label: str(o.label) ?? str(o.tool) ?? 'Änderung', reason: str(o.reason) ?? '', risk };
  });
}

/** Checklist of the changes an agent run prepared (#298); all are checked by default. */
function BatchChecklist({
  items,
  selected,
  onToggle,
  editable,
}: {
  items: BatchItem[];
  selected: Set<number>;
  onToggle: (index: number, checked: boolean) => void;
  editable: boolean;
}) {
  return (
    <ul className="mt-2 flex flex-col gap-1.5" data-testid="action-batch-items" aria-label="Vorbereitete Änderungen">
      {items.map((it, i) => (
        <li key={`${i}-${it.label}`} className="flex items-start gap-2">
          {editable ? (
            <Checkbox
              className="mt-0.5"
              checked={selected.has(i)}
              onCheckedChange={(v) => onToggle(i, v === true)}
              aria-label={it.label}
              data-testid="action-batch-item"
            />
          ) : (
            <span className="mt-0.5 text-xs text-muted-foreground" aria-hidden>
              {selected.has(i) ? '✓' : '–'}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-1.5">
              <span>{it.label}</span>
              {it.risk === 'critical' && <Badge variant="warning">fragt immer</Badge>}
              {!editable && !selected.has(i) && <span className="text-xs text-muted-foreground">(nicht ausgewählt)</span>}
            </p>
            {it.reason && <p className="text-xs text-muted-foreground">{it.reason}</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Card for an action proposal from the agent, with confirm/reject. */
export function ActionCard({ action, onResolved }: { action: ActionRecord; onResolved?: (a: ActionRecord) => void }) {
  const [current, setCurrent] = useState<ActionRecord>(action);
  const [strongOpen, setStrongOpen] = useState(false);
  const { run, busy } = useRun();
  const st = STATUS[current.status];
  const items = batchItems(current);
  const isBatch = current.actionType === 'agent_batch';
  const [selected, setSelected] = useState<Set<number>>(() => {
    const pre = (current.proposedParameters as Params).selected;
    return new Set(Array.isArray(pre) ? pre.filter((n): n is number => typeof n === 'number') : items.map((_, i) => i));
  });
  const allSelected = selected.size === items.length;
  const toggle = (index: number, checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(index);
      else next.delete(index);
      return next;
    });

  async function resolve(decision: 'approve' | 'reject', strongConfirmed = false) {
    // partial confirmation of an agent batch: only the checked items are executed
    const parameterOverrides = isBatch && !allSelected ? { selected: [...selected].sort((a, b) => a - b) } : undefined;
    const out = await run(
      () =>
        decision === 'approve'
          ? call('actions:resolve', {
              decision: 'approve',
              actionId: current.id,
              confirmed: true,
              strongConfirmed,
              ...(parameterOverrides ? { parameterOverrides } : {}),
            })
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
      {isBatch && items.length > 0 && (
        <>
          <BatchChecklist items={items} selected={selected} onToggle={toggle} editable={current.status === 'proposed'} />
          {current.status === 'proposed' && items.length > 1 && (
            <p className="mt-1 text-xs text-muted-foreground" aria-live="polite">
              {selected.size} von {items.length} ausgewählt
            </p>
          )}
        </>
      )}
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
            disabled={busy || (isBatch && selected.size === 0)}
            data-testid="action-approve"
            onClick={() => (current.requiredConfirmation === 'strong' ? setStrongOpen(true) : void resolve('approve'))}
          >
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Check aria-hidden />} {isBatch ? 'Ausführen' : 'Bestätigen'}
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
          {isBatch && (
            <ul className="mt-2 list-disc pl-5">
              {items
                .filter((_, i) => selected.has(i))
                .map((it, i) => (
                  <li key={`${i}-${it.label}`}>{it.label}</li>
                ))}
            </ul>
          )}
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
