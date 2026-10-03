'use client';

import { useState } from 'react';
import { ACTIVE_DECISION_STATUSES } from '@archivist/shared';
import { Field } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { call } from '@/lib/ipc';
import { formatLongDate } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import type { ActionRecord } from '@/lib/types';

export function SupersedeDialog({
  open,
  onOpenChange,
  oldId,
  onProposed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  oldId: string;
  onProposed: (action: ActionRecord) => void;
}) {
  const all = useQuery('decisions:list', {}, { enabled: open });
  const [target, setTarget] = useState('');
  const { run, busy } = useRun();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Wodurch wird diese Entscheidung ersetzt?</DialogTitle>
          <DialogDescription>
            Wähle die neuere, gültige oder bestätigte Entscheidung. Es wird ein Vorschlag erstellt, den du anschließend bestätigst.
          </DialogDescription>
        </DialogHeader>
        <Field label="Neuere Entscheidung" htmlFor="sup-target">
          <Select id="sup-target" value={target} onChange={(e) => setTarget(e.target.value)} data-testid="supersede-target">
            <option value="">Entscheidung wählen …</option>
            {(all.data ?? [])
              .filter((decision) => decision.id !== oldId && ACTIVE_DECISION_STATUSES.includes(decision.status))
              .map((decision) => (
                <option key={decision.id} value={decision.id}>
                  {(decision.title || decision.decisionText).slice(0, 80)} ({formatLongDate(decision.decidedAt, 'ohne Datum')})
                </option>
              ))}
          </Select>
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button
            disabled={!target || busy}
            data-testid="supersede-propose"
            onClick={async () => {
              const action = await run(() => call('decisions:proposeSupersede', { oldDecisionId: oldId, newDecisionId: target }));
              if (action) onProposed(action);
            }}
          >
            Vorschlag erstellen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
