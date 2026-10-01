'use client';

import { useState } from 'react';
import type { IpcInput } from '@archivist/shared';
import { Field } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { nonEmpty } from '@/lib/utils';

export type EventFormInput = IpcInput<'events:create'>;

/**
 * Dialog "Ereignis hinzufügen" (title, date, description, topic, project), shared by the timeline and the
 * knowledge page. `onSubmit` performs the IPC call and returns whether the dialog may close.
 * Mount it with a changing `key` to reset the fields.
 */
export function EventFormDialog({
  open,
  onOpenChange,
  onSubmit,
  initialTitle = '',
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSubmit: (input: EventFormInput) => Promise<boolean>;
  initialTitle?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState('');
  const [occurredAt, setOccurredAt] = useState('');
  const [topic, setTopic] = useState('');
  const [project, setProject] = useState('');
  async function save() {
    setBusy(true);
    try {
      const ok = await onSubmit({
        title: title.trim(),
        description: nonEmpty(description) ?? null,
        occurredAt,
        topic: nonEmpty(topic) ?? null,
        project: nonEmpty(project) ?? null,
        sourceIds: [],
      });
      if (ok) onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" data-testid="event-form">
        <DialogHeader>
          <DialogTitle>Ereignis hinzufügen</DialogTitle>
          <DialogDescription>Ein Ereignis ist etwas, das an einem bestimmten Tag stattgefunden hat, z. B. „Beitrag eingereicht“.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Was ist passiert? *" htmlFor="ev-title" className="sm:col-span-2">
            <Input id="ev-title" value={title} onChange={(e) => setTitle(e.target.value)} data-testid="event-title" />
          </Field>
          <Field label="Datum *" htmlFor="ev-date">
            <Input id="ev-date" type="date" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} data-testid="event-date" />
          </Field>
          <div />
          <Field label="Beschreibung" htmlFor="ev-desc" className="sm:col-span-2">
            <Textarea id="ev-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label="Thema" htmlFor="ev-topic">
            <Input id="ev-topic" value={topic} onChange={(e) => setTopic(e.target.value)} />
          </Field>
          <Field label="Projekt" htmlFor="ev-project">
            <Input id="ev-project" value={project} onChange={(e) => setProject(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button disabled={busy || !title.trim() || !occurredAt} onClick={() => void save()} data-testid="event-save">
            Speichern
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
