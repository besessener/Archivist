'use client';

import { EditableDecisionStatus, isEditableDecisionStatus, type DecisionStatus } from '@archivist/shared';
import { Field } from '@/components/common/states';
import { Select } from '@/components/ui/select';
import { formatLongDate } from '@/lib/format';
import { DECISION_STATUS_LABELS } from '@/lib/labels';
import { useQuery } from '@/lib/use-query';
import type { DecisionRecord } from '@/lib/types';

/** Statuses that need an explicit confirmation (stage 2) and get an undo entry; never sent via `decisions:update`. */
export type CriticalStatus = 'superseded' | 'revoked';
const isCritical = (status: DecisionStatus): status is CriticalStatus => status === 'superseded' || status === 'revoked';

/** Superseded/revoked decisions keep their status in the form; the way back is undo in the audit log. */
export function isStatusLocked(decision: DecisionRecord | null): boolean {
  return decision !== null && !isEditableDecisionStatus(decision.status);
}

export function pendingCriticalStatus(decision: DecisionRecord | null, status: DecisionStatus): CriticalStatus | null {
  return decision && !isStatusLocked(decision) && isCritical(status) ? status : null;
}

export function DecisionStatusField({
  decision,
  status,
  onStatusChange,
}: {
  decision: DecisionRecord;
  status: DecisionStatus;
  onStatusChange: (status: DecisionStatus) => void;
}) {
  const statusLocked = isStatusLocked(decision);
  const pendingCritical = pendingCriticalStatus(decision, status);
  return (
    <Field
      label="Status"
      htmlFor="d-status"
      hint={
        statusLocked
          ? 'Rückgängig machen kannst du das unter Einstellungen → Änderungsprotokoll.'
          : pendingCritical
            ? 'Wird erst nach deiner Bestätigung übernommen und lässt sich im Änderungsprotokoll rückgängig machen.'
            : undefined
      }
    >
      <Select
        id="d-status"
        value={status}
        disabled={statusLocked}
        onChange={(e) => onStatusChange(e.target.value as DecisionStatus)}
        data-testid="decision-status"
      >
        {statusLocked ? (
          <option value={decision.status}>{DECISION_STATUS_LABELS[decision.status]}</option>
        ) : (
          <>
            {EditableDecisionStatus.options.map((option) => (
              <option key={option} value={option}>
                {DECISION_STATUS_LABELS[option]}
              </option>
            ))}
            <option value="superseded">{DECISION_STATUS_LABELS.superseded} …</option>
            <option value="revoked">{DECISION_STATUS_LABELS.revoked} …</option>
          </>
        )}
      </Select>
    </Field>
  );
}

export function SupersededByField({
  decision,
  open,
  value,
  onChange,
}: {
  decision: DecisionRecord;
  open: boolean;
  value: string;
  onChange: (id: string) => void;
}) {
  const others = useQuery('decisions:list', {}, { scopes: ['decisions'], enabled: open });
  return (
    <Field label="Ersetzt durch" htmlFor="d-superseded-by">
      <Select id="d-superseded-by" value={value} onChange={(e) => onChange(e.target.value)} data-testid="decision-superseded-by">
        <option value="">Neuere Entscheidung wählen …</option>
        {(others.data ?? [])
          .filter((other) => other.id !== decision.id)
          .map((other) => (
            <option key={other.id} value={other.id}>
              {(other.title || other.decisionText).slice(0, 80)} ({formatLongDate(other.decidedAt, 'ohne Datum')})
            </option>
          ))}
      </Select>
    </Field>
  );
}
