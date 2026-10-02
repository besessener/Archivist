'use client';

import { ExtraSubjectFields, useExtraSubjects } from '@/components/common/extra-subjects';
import { useState } from 'react';
import type { IpcInput, IpcOutput } from '@archivist/shared';
import { MARKDOWN_HINT } from '@/components/common/markdown';
import { Field } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { nonEmpty, parseList } from '@/lib/utils';

export type EventFormInput = IpcInput<'events:create'>;
type EventRecord = IpcOutput<'events:create'>;
type EventPatch = IpcInput<'events:update'>['patch'];

/** Only the fields the user actually changed in the form, so an edit neither rewrites nor relinks untouched values. */
export function eventPatch(event: EventRecord, input: EventFormInput): EventPatch {
  const patch: EventPatch = {};
  if (input.title !== event.title) patch.title = input.title;
  if ((input.description ?? null) !== (event.description ?? null)) patch.description = input.description ?? null;
  if (input.occurredAt !== event.occurredAt.slice(0, 10)) patch.occurredAt = input.occurredAt;
  if ((input.topic ?? null) !== (event.topicName ?? null)) patch.topic = input.topic ?? null;
  if ((input.project ?? null) !== (event.projectName ?? null)) patch.project = input.project ?? null;
  if (input.participants && input.participants.join('\n') !== event.participants.join('\n')) patch.participants = input.participants;
  return patch;
}

/**
 * Dialog "Ereignis hinzufügen" / "Ereignis bearbeiten" (title, date, description, topic, project, participants), shared by the
 * timeline and the knowledge page. Pass `event` to edit an existing event (fields are prefilled). `onSubmit` performs
 * the IPC call and returns whether the dialog may close. Mount it with a changing `key` to reset the fields.
 */
export function EventFormDialog({
  open,
  onOpenChange,
  onSubmit,
  initialTitle = '',
  event = null,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Returns whether the dialog may close – or the id of the saved event (then its further topics/projects are stored too). */
  onSubmit: (input: EventFormInput) => Promise<boolean | string>;
  initialTitle?: string;
  event?: EventRecord | null;
}) {
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(event?.title ?? initialTitle);
  const [description, setDescription] = useState(event?.description ?? '');
  const [occurredAt, setOccurredAt] = useState(event?.occurredAt.slice(0, 10) ?? '');
  const [topic, setTopic] = useState(event?.topicName ?? '');
  const [project, setProject] = useState(event?.projectName ?? '');
  const [participants, setParticipants] = useState(event?.participants.join(', ') ?? '');
  const extra = useExtraSubjects(event?.id ?? undefined, open);
  async function save() {
    setBusy(true);
    try {
      const ok = await onSubmit({
        title: title.trim(),
        description: nonEmpty(description) ?? null,
        occurredAt,
        topic: nonEmpty(topic) ?? null,
        project: nonEmpty(project) ?? null,
        participants: parseList(participants),
        sourceIds: [],
      });
      const savedId = typeof ok === 'string' ? ok : ok ? event?.id : undefined;
      if (savedId) await extra.save(savedId);
      if (ok) onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" data-testid="event-form">
        <DialogHeader>
          <DialogTitle>{event ? 'Ereignis bearbeiten' : 'Ereignis hinzufügen'}</DialogTitle>
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
          <Field label="Beschreibung" htmlFor="ev-desc" hint={MARKDOWN_HINT} className="sm:col-span-2">
            <Textarea id="ev-desc" value={description} onChange={(e) => setDescription(e.target.value)} data-testid="event-description" />
          </Field>
          <Field label="Thema" htmlFor="ev-topic">
            <Input id="ev-topic" value={topic} onChange={(e) => setTopic(e.target.value)} data-testid="event-topic" />
          </Field>
          <Field label="Projekt" htmlFor="ev-project">
            <Input id="ev-project" value={project} onChange={(e) => setProject(e.target.value)} data-testid="event-project" />
          </Field>
          <div className="sm:col-span-2">
            <ExtraSubjectFields idPrefix="event" {...extra} />
          </div>
          <Field label="Beteiligte (kommagetrennt)" htmlFor="ev-participants" className="sm:col-span-2">
            <Input id="ev-participants" value={participants} onChange={(e) => setParticipants(e.target.value)} data-testid="event-participants" />
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
