'use client';

import { useState } from 'react';
import { Field } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { call } from '@/lib/ipc';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import type { ActionRecord } from '@/lib/types';

export function MergeDialog({
  open,
  onOpenChange,
  sourceId,
  sourceName,
  onProposed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceId: string;
  sourceName: string;
  onProposed: (action: ActionRecord) => void;
}) {
  const topics = useQuery('knowledge:listEntities', { type: 'topic', limit: 1000 }, { enabled: open });
  const [target, setTarget] = useState('');
  const { run, busy } = useRun();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Themen zusammenführen vorschlagen</DialogTitle>
          <DialogDescription>
            „{sourceName}“ soll in ein anderes Thema aufgehen. Es wird nur ein Vorschlag erstellt – du bestätigst ihn anschließend.
          </DialogDescription>
        </DialogHeader>
        <Field label="Zusammenführen mit" htmlFor="merge-target">
          <Select id="merge-target" value={target} onChange={(e) => setTarget(e.target.value)} data-testid="merge-target">
            <option value="">Thema wählen …</option>
            {(topics.data ?? [])
              .filter((topic) => topic.id !== sourceId)
              .map((topic) => (
                <option key={topic.id} value={topic.id}>
                  {topic.name}
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
              const action = await run(() => call('knowledge:proposeMerge', { sourceTopicId: sourceId, targetTopicId: target }));
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
