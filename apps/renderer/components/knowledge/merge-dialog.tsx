'use client';

import { useState } from 'react';
import { Field } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { call } from '@/lib/ipc';
import { ENTITY_TYPE_LABELS } from '@/lib/nav';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import type { ActionRecord } from '@/lib/types';

const MERGEABLE_TYPES = ['topic', 'project', 'person', 'tag'] as const;
type MergeableType = (typeof MERGEABLE_TYPES)[number];

export function isMergeable(type: string): type is MergeableType {
  return (MERGEABLE_TYPES as readonly string[]).includes(type);
}

export function MergeDialog({
  open,
  onOpenChange,
  source,
  onProposed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: { id: string; name: string; type: MergeableType };
  onProposed: (action: ActionRecord) => void;
}) {
  const candidates = useQuery('knowledge:listEntities', { type: source.type, limit: 1000 }, { enabled: open });
  const label = ENTITY_TYPE_LABELS[source.type];
  const [target, setTarget] = useState('');
  const { run, busy } = useRun();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{label} zusammenführen vorschlagen</DialogTitle>
          <DialogDescription>
            „{source.name}“ soll in einen anderen Eintrag dieser Art aufgehen. Es wird nur ein Vorschlag erstellt – du bestätigst ihn anschließend.
          </DialogDescription>
        </DialogHeader>
        <Field label="Zusammenführen mit" htmlFor="merge-target">
          <Select id="merge-target" value={target} onChange={(e) => setTarget(e.target.value)} data-testid="merge-target">
            <option value="">{label} wählen …</option>
            {(candidates.data ?? [])
              .filter((candidate) => candidate.id !== source.id)
              .map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
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
            data-testid="merge-propose"
            onClick={async () => {
              const action = await run(() => call('knowledge:proposeMerge', { sourceId: source.id, targetId: target }));
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
