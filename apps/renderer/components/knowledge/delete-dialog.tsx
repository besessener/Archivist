'use client';

import type { IpcOutput } from '@archivist/shared';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { call } from '@/lib/ipc';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';

type Entity = IpcOutput<'knowledge:getEntity'>['entity'];
type Impact = IpcOutput<'knowledge:subjectImpact'>;

interface Deletion {
  title: string;
  success: string;
  /** What the deletion takes with it, in plain words. */
  effect: string;
  remove: (id: string) => Promise<unknown>;
}

const SUBJECT = 'Alle Verknüpfungen und Aliasse werden entfernt. Der Name wird von der automatischen Erkennung nicht wieder angelegt.';
const subject = (title: string, success: string): Deletion => ({
  title,
  success,
  effect: SUBJECT,
  remove: (id) => call('knowledge:deleteSubject', { id, confirmed: true }),
});

const DELETIONS: Partial<Record<Entity['type'], Deletion>> = {
  person: subject('Person löschen?', 'Person gelöscht.'),
  topic: subject('Thema löschen?', 'Thema gelöscht.'),
  project: subject('Projekt löschen?', 'Projekt gelöscht.'),
  tag: subject('Schlagwort löschen?', 'Schlagwort gelöscht.'),
  note: {
    title: 'Notiz löschen?',
    success: 'Notiz gelöscht.',
    effect: 'Die Notiz wird aus Wissensgraph und Suche entfernt.',
    remove: (id) => call('knowledge:deleteNote', { id, confirmed: true }),
  },
  task: {
    title: 'Offenen Punkt löschen?',
    success: 'Punkt gelöscht.',
    effect: 'Der offene Punkt wird samt Erinnerungen aus Liste, Suche und Wissensgraph entfernt.',
    remove: (id) => call('openItems:delete', { id, confirmed: true }),
  },
  event: {
    title: 'Ereignis löschen?',
    success: 'Ereignis gelöscht.',
    effect: 'Das Ereignis wird aus Zeitleiste, Suche und Wissensgraph entfernt.',
    remove: (id) => call('events:delete', { id, confirmed: true }),
  },
};

/** Entries of the knowledge page that can be deleted (the user's own person and documents are never offered). */
export const canDelete = (entity: Entity): boolean => !entity.isSelf && entity.type in DELETIONS;

const isSubject = (type: Entity['type']) => type === 'person' || type === 'topic' || type === 'project' || type === 'tag';

function ImpactNote({ impact }: { impact: Impact }) {
  const lost = impact.records.filter((record) => record.main);
  const connections = impact.relations + impact.records.length;
  if (connections === 0) return <p className="text-sm text-muted-foreground">Es hängt nichts daran.</p>;
  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="delete-impact">
      <p>{connections === 1 ? '1 Verknüpfung wird entfernt.' : `${connections} Verknüpfungen werden entfernt.`}</p>
      {lost.length > 0 && (
        <div>
          <p>Diese Einträge verlieren ihr Hauptthema oder -projekt (die Ablage ändert sich nicht, nichts wird verschoben):</p>
          <ul className="mt-1 list-disc pl-5 text-muted-foreground">
            {lost.slice(0, 8).map((record) => (
              <li key={`${record.table}:${record.id}`}>{record.title}</li>
            ))}
            {lost.length > 8 && <li>… und {lost.length - 8} weitere</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

export interface DeleteEntityDialogProps {
  entity: Entity;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}

/** Confirmation for deleting an entry of the knowledge page; the change log offers the undo. */
export function DeleteEntityDialog({ entity, open, onOpenChange, onDeleted }: DeleteEntityDialogProps) {
  const { run } = useRun();
  const deletion = DELETIONS[entity.type];
  const impact = useQuery('knowledge:subjectImpact', { id: entity.id }, { scopes: ['knowledge'], enabled: open && isSubject(entity.type) });
  if (!deletion) return null;
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={deletion.title}
      description={`„${entity.name}“: ${deletion.effect} Rückgängig machen kannst du das unter Einstellungen → Änderungsprotokoll.`}
      confirmLabel="Löschen"
      destructive
      onConfirm={async () => {
        const out = await run(() => deletion.remove(entity.id), { success: deletion.success });
        onOpenChange(false);
        if (out !== undefined) onDeleted();
      }}
    >
      {impact.data && <ImpactNote impact={impact.data} />}
    </ConfirmDialog>
  );
}
