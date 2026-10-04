'use client';

import { useState } from 'react';
import { Field } from '@/components/common/states';
import { DecisionPicker } from '@/components/decisions/decision-picker';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { call } from '@/lib/ipc';
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
          <DecisionPicker excludeId={oldId} open={open} value={target} onChange={setTarget} selectId="sup-target" testId="supersede-target" />
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
