'use client';

import { useEffect, useState } from 'react';
import { FolderKanban } from 'lucide-react';
import { Field } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { call } from '@/lib/ipc';
import { plural } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';

const NEW = '__new__';

/**
 * Puts one or several entries into a case („Vorgang“, #286, #291): an open case or a new one. One undo step in the change
 * log; an entry can belong to several cases.
 */
export function CaseAssignDialog({
  entryIds,
  open,
  onOpenChange,
  onDone,
}: {
  entryIds: string[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone?: (assigned: number) => void;
}) {
  const cases = useQuery('cases:list', { includeClosed: false }, { scopes: ['knowledge'], enabled: open });
  const [choice, setChoice] = useState('');
  const [name, setName] = useState('');
  const { run, busy } = useRun();
  useEffect(() => {
    if (!open) return;
    setName('');
    setChoice((c) => c || (cases.data?.[0]?.id ?? NEW));
  }, [open, cases.data]);
  const isNew = choice === NEW || (cases.data !== undefined && cases.data.length === 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="case-assign-dialog">
        <DialogHeader>
          <DialogTitle>
            {entryIds.length === 1 ? 'Zu einem Vorgang hinzufügen' : `${plural(entryIds.length, 'Eintrag', 'Einträge')} zu einem Vorgang hinzufügen`}
          </DialogTitle>
          <DialogDescription>
            Ein Vorgang sammelt, was zu einer Sache gehört – z. B. „Steuererklärung 2025“ oder „Autokauf“. Ein Eintrag kann zu mehreren Vorgängen gehören.
            Rückgängig im Änderungsprotokoll.
          </DialogDescription>
        </DialogHeader>
        {cases.data && cases.data.length > 0 && (
          <Field label="Vorgang" htmlFor="case-assign-choice">
            <Select id="case-assign-choice" value={choice} onChange={(e) => setChoice(e.target.value)} data-testid="case-assign-choice">
              {cases.data.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({plural(c.entries, 'Eintrag', 'Einträge')})
                </option>
              ))}
              <option value={NEW}>Neuer Vorgang …</option>
            </Select>
          </Field>
        )}
        {isNew && (
          <Field label="Name des neuen Vorgangs" htmlFor="case-assign-name">
            <Input id="case-assign-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. Autokauf" data-testid="case-assign-name" />
          </Field>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button
            disabled={busy || (isNew ? !name.trim() : !choice)}
            data-testid="case-assign-save"
            onClick={async () => {
              const out = await run(
                async () => {
                  const caseId = isNew ? (await call('cases:create', { name: name.trim() })).case.id : choice;
                  return call('cases:assign', { entryIds, caseId });
                },
                { success: 'Zum Vorgang hinzugefügt. Rückgängig im Änderungsprotokoll.' },
              );
              if (out) {
                onOpenChange(false);
                onDone?.(out.assigned);
              }
            }}
          >
            <FolderKanban aria-hidden /> Hinzufügen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
