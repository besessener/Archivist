'use client';

import { useEffect, useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { call } from '@/lib/ipc';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import { useToast, type ToastInput } from '@/lib/toast';
import type { ActionRecord } from '@/lib/types';
import { ConfidenceBadge } from './confidence';
import { ConfirmDialog } from './confirm-dialog';
import { EntityChip } from './entity-chip';
import { formatDate } from '@/lib/format';
import { withMembership } from '@/lib/utils';

const STATUS: Record<ActionRecord['status'], { label: string; variant: 'secondary' | 'success' | 'danger' | 'warning' | 'info' }> = {
  proposed: { label: 'Wartet auf deine Entscheidung', variant: 'warning' },
  approved: { label: 'Wird ausgeführt', variant: 'info' },
  rejected: { label: 'Abgelehnt', variant: 'secondary' },
  executed: { label: 'Ausgeführt', variant: 'success' },
  failed: { label: 'Fehlgeschlagen', variant: 'danger' },
  withdrawn: { label: 'Nicht mehr aktuell', variant: 'secondary' },
};

/** The toast follows the status the main process returned: the action may already have been settled elsewhere (e.g. „ja“ in the chat). */
const RESOLVED_TOASTS: Record<ActionRecord['status'], (action: ActionRecord) => ToastInput> = {
  proposed: () => ({ title: 'Die Aktion wartet noch auf deine Entscheidung.', variant: 'info' }),
  approved: () => ({ title: 'Aktion bestätigt.', variant: 'success' }),
  executed: () => ({ title: 'Aktion ausgeführt.', variant: 'success' }),
  rejected: () => ({ title: 'Vorschlag abgelehnt.', variant: 'success' }),
  withdrawn: () => ({ title: 'Nicht mehr aktuell.', variant: 'info' }),
  failed: (action) => ({ title: 'Aktion fehlgeschlagen.', description: action.result ?? undefined, variant: 'error' }),
};

type Params = Record<string, unknown>;
type Value = [label: string, value: string];
const MISSING = 'nicht angegeben';
const nonBlank = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '') : [];
const optional = (label: string, value: string | null): Value[] => (value ? [[label, value]] : []);
const dayOrMissing = (value: unknown): string => (nonBlank(value) ? formatDate(nonBlank(value)) : MISSING);

function decisionValues(parameters: Params): Value[] {
  const participants = stringList(parameters.participants);
  const evidence = nonBlank(parameters.evidence);
  return [
    ['Entscheidung', nonBlank(parameters.decisionText) ?? MISSING],
    ['Datum', dayOrMissing(parameters.decidedAt)],
    ['Beteiligte', participants.length ? participants.join(', ') : MISSING],
    ['Thema', nonBlank(parameters.topic) ?? MISSING],
    ...optional('Projekt', nonBlank(parameters.project)),
    ...optional('Beleg', evidence && `„${evidence}“`),
  ];
}

function closeValues(parameters: Params): Value[] {
  return optional(parameters.status === 'dismissed' ? 'Warum verworfen' : 'Lösung', nonBlank(parameters.resolutionNote));
}

function openItemValues(parameters: Params): Value[] {
  return [
    ['Punkt', nonBlank(parameters.title) ?? MISSING],
    ...optional('Beschreibung', nonBlank(parameters.description)),
    ['Fällig', dayOrMissing(parameters.dueAt)],
    ['Verantwortlich', nonBlank(parameters.responsible) ?? MISSING],
  ];
}

const VALUES_BY_TYPE: Partial<Record<ActionRecord['actionType'], (parameters: Params) => Value[]>> = {
  record_decision: decisionValues,
  close_open_item: closeValues,
  create_open_item: openItemValues,
};

/** The values a confirmation would store – the label alone can say something else than what is saved (#178). */
function proposedValues(action: ActionRecord): Value[] {
  return VALUES_BY_TYPE[action.actionType]?.(action.proposedParameters) ?? [];
}

function ProposedValues({ action }: { action: ActionRecord }) {
  const values = proposedValues(action);
  if (values.length === 0) return null;
  const incomplete =
    action.actionType === 'record_decision' && values.some(([label, value]) => ['Datum', 'Beteiligte', 'Thema'].includes(label) && value === MISSING);
  return (
    <div className="mt-2 rounded-md bg-muted/50 p-2 text-xs" data-testid="action-values">
      <dl className="grid gap-x-3 gap-y-1 sm:grid-cols-[7rem_1fr]">
        {values.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className={value === MISSING ? 'text-muted-foreground' : undefined}>{value}</dd>
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
  return items.map((item) => {
    const entry = (item && typeof item === 'object' ? item : {}) as Params;
    const risk = entry.risk === 'critical' || entry.risk === 'read' ? entry.risk : 'write';
    return { label: nonBlank(entry.label) ?? nonBlank(entry.tool) ?? 'Änderung', reason: nonBlank(entry.reason) ?? '', risk };
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
      {items.map((item, i) => (
        <li key={`${i}-${item.label}`} className="flex items-start gap-2">
          {editable ? (
            <Checkbox
              className="mt-0.5"
              checked={selected.has(i)}
              onCheckedChange={(checked) => onToggle(i, checked === true)}
              aria-label={item.label}
              data-testid="action-batch-item"
            />
          ) : (
            <span className="mt-0.5 text-xs text-muted-foreground" aria-hidden>
              {selected.has(i) ? '✓' : '–'}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-1.5">
              <span>{item.label}</span>
              {item.risk === 'critical' && <Badge variant="warning">fragt immer</Badge>}
              {!editable && !selected.has(i) && <span className="text-xs text-muted-foreground">(nicht ausgewählt)</span>}
            </p>
            {item.reason && <p className="text-xs text-muted-foreground">{item.reason}</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Card for an action proposal from the agent, with confirm/reject. */
export function ActionCard({ action, onResolved }: { action: ActionRecord; onResolved?: (resolved: ActionRecord) => void }) {
  const [current, setCurrent] = useState<ActionRecord>(action);
  useEffect(() => {
    setCurrent(action);
  }, [action]);
  const { toast } = useToast();
  // a big action runs as a job (#254): while it runs, the card reloads it whenever the job or the action changes
  const running = useQuery('actions:get', { id: current.id }, { scopes: ['status'], jobs: true, enabled: current.status === 'approved' });
  useEffect(() => {
    if (running.data) setCurrent(running.data);
  }, [running.data]);
  const [strongOpen, setStrongOpen] = useState(false);
  const { run, busy } = useRun();
  const status = STATUS[current.status];
  const items = batchItems(current);
  const isBatch = current.actionType === 'agent_batch';
  const [selected, setSelected] = useState<Set<number>>(() => {
    const preselected = (current.proposedParameters as Params).selected;
    return new Set(Array.isArray(preselected) ? preselected.filter((index): index is number => typeof index === 'number') : items.map((_, i) => i));
  });
  const allSelected = selected.size === items.length;
  const toggle = (index: number, checked: boolean) => setSelected((previous) => withMembership(previous, { value: index, present: checked }));

  async function resolve({ decision, strongConfirmed }: { decision: 'approve' | 'reject'; strongConfirmed: boolean }) {
    // partial confirmation of an agent batch: only the checked items are executed
    const parameterOverrides = isBatch && !allSelected ? { selected: [...selected].sort((a, b) => a - b) } : undefined;
    const resolved = await run(
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
    );
    if (resolved) {
      toast(RESOLVED_TOASTS[resolved.status](resolved));
      setCurrent(resolved);
      onResolved?.(resolved);
    }
    return resolved;
  }

  return (
    <div className="rounded-lg border bg-background p-3 text-sm" data-testid="action-card" data-status={current.status}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 font-medium">{current.label}</p>
        <Badge variant={status.variant}>{status.label}</Badge>
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
        {/* the agent's prepared changes are the user's own request – no made-up estimate (#167) */}
        {!isBatch && <ConfidenceBadge value={current.confidence} />}
        {current.requiredConfirmation === 'strong' && <Badge variant="danger">Besonders folgenreich</Badge>}
        {current.affectedEntities.map((entity) => (
          <EntityChip key={`${entity.type}-${entity.id}`} type={entity.type} id={entity.id} label={entity.label} detail={entity.detail} />
        ))}
      </div>
      {current.result && <p className="mt-2 text-xs text-muted-foreground">{current.result}</p>}
      {current.status === 'proposed' && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={busy || (isBatch && selected.size === 0)}
            data-testid="action-approve"
            onClick={() => (current.requiredConfirmation === 'strong' ? setStrongOpen(true) : void resolve({ decision: 'approve', strongConfirmed: false }))}
          >
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Check aria-hidden />} {isBatch ? 'Ausführen' : 'Bestätigen'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            data-testid="action-reject"
            onClick={() => void resolve({ decision: 'reject', strongConfirmed: false })}
          >
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
          const resolved = await resolve({ decision: 'approve', strongConfirmed: true });
          if (resolved) setStrongOpen(false);
        }}
      >
        <div className="rounded-md border bg-muted/50 p-3 text-sm">
          <p className="font-medium">{current.label}</p>
          <p className="mt-1 text-muted-foreground">{current.rationale}</p>
          {isBatch && (
            <ul className="mt-2 list-disc pl-5">
              {items
                .filter((_, i) => selected.has(i))
                .map((item, i) => (
                  <li key={`${i}-${item.label}`}>{item.label}</li>
                ))}
            </ul>
          )}
          {current.affectedEntities.length > 0 && (
            <ul className="mt-2 list-disc pl-5">
              {current.affectedEntities.map((entity) => (
                <li key={`${entity.type}-${entity.id}`}>{entity.label}</li>
              ))}
            </ul>
          )}
        </div>
      </ConfirmDialog>
    </div>
  );
}
