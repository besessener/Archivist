'use client';

import { useState } from 'react';
import { EditableOpenItemStatus, isEditableOpenItemStatus, localDate } from '@archivist/shared';
import { ExtraSubjectFields, useExtraSubjects } from '@/components/common/extra-subjects';
import { MARKDOWN_HINT } from '@/components/common/markdown';
import { Field } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { CheckboxField } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { call } from '@/lib/ipc';
import { OPEN_ITEM_STATUS_LABELS } from '@/lib/labels';
import { useRun } from '@/lib/use-run';
import type { OpenItemRecord } from '@/lib/types';
import { nonEmpty } from '@/lib/utils';

type Priority = 'low' | 'normal' | 'high';

/** Creates an open item (`item` null) or edits one. */
export function ItemFormDialog({
  open,
  onOpenChange,
  item,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: OpenItemRecord | null;
  onSaved: () => void;
}) {
  const { run, busy } = useRun();
  const [title, setTitle] = useState(item?.title ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [responsible, setResponsible] = useState(item?.responsibleName ?? '');
  const [responsibleUnknown, setResponsibleUnknown] = useState(item?.responsibleUnknown ?? false);
  const [dueAt, setDueAt] = useState(item?.dueAt ? localDate(item.dueAt) : '');
  const [dueUnknown, setDueUnknown] = useState(item?.dueUnknown ?? false);
  const [priority, setPriority] = useState<Priority>(item?.priority ?? 'normal');
  // closing is never part of an edit: it needs the confirmed „Erledigt …“ dialog (with undo)
  const [status, setStatus] = useState<EditableOpenItemStatus>(item && isEditableOpenItemStatus(item.status) ? item.status : 'open');
  const statusEditable = item !== null && isEditableOpenItemStatus(item.status);
  const [topic, setTopic] = useState(item?.topicName ?? '');
  const [project, setProject] = useState(item?.projectName ?? '');
  const extra = useExtraSubjects(item?.id, { open });

  async function save() {
    const base = {
      title: title.trim(),
      description: nonEmpty(description) ?? null,
      topic: nonEmpty(topic) ?? null,
      project: nonEmpty(project) ?? null,
      responsible: responsibleUnknown ? null : (nonEmpty(responsible) ?? null),
      dueAt: dueUnknown ? null : dueAt || null,
      priority,
      responsibleUnknown,
      dueUnknown,
    };
    const saved = await run(
      async () => {
        const record = item
          ? await call('openItems:update', {
              id: item.id,
              patch: { ...base, ...(statusEditable ? { status } : {}) },
            })
          : await call('openItems:create', base);
        await extra.save(record.id);
        return record;
      },
      { success: item ? 'Änderungen gespeichert.' : 'Offener Punkt angelegt.' },
    );
    if (!saved) return;
    onSaved();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" data-testid="open-item-form">
        <DialogHeader>
          <DialogTitle>{item ? 'Offenen Punkt bearbeiten' : 'Neuer offener Punkt'}</DialogTitle>
          <DialogDescription>Wenn Verantwortlicher oder Termin nicht feststehen, kannst du das ausdrücklich so markieren.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Was ist offen? *" htmlFor="oi-title" className="sm:col-span-2">
            <Input id="oi-title" value={title} onChange={(e) => setTitle(e.target.value)} data-testid="open-item-title" />
          </Field>
          <Field label="Beschreibung" htmlFor="oi-desc" hint={MARKDOWN_HINT} className="sm:col-span-2">
            <Textarea id="oi-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label="Verantwortlich" htmlFor="oi-resp">
            <Input
              id="oi-resp"
              value={responsibleUnknown ? '' : responsible}
              disabled={responsibleUnknown}
              onChange={(e) => setResponsible(e.target.value)}
              data-testid="open-item-responsible"
            />
            <CheckboxField
              checked={responsibleUnknown}
              onCheckedChange={(checked) => setResponsibleUnknown(checked === true)}
              label="Verantwortlicher unbekannt"
              className="text-xs"
              data-testid="open-item-resp-unknown"
            />
          </Field>
          <Field label="Termin" htmlFor="oi-due">
            <Input
              id="oi-due"
              type="date"
              value={dueUnknown ? '' : dueAt}
              disabled={dueUnknown}
              onChange={(e) => setDueAt(e.target.value)}
              data-testid="open-item-due"
            />
            <CheckboxField
              checked={dueUnknown}
              onCheckedChange={(checked) => setDueUnknown(checked === true)}
              label="Termin unbekannt"
              className="text-xs"
              data-testid="open-item-due-unknown"
            />
          </Field>
          <Field label="Priorität" htmlFor="oi-prio">
            <Select id="oi-prio" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              <option value="low">Niedrig</option>
              <option value="normal">Normal</option>
              <option value="high">Hoch</option>
            </Select>
          </Field>
          {statusEditable && (
            <Field label="Status" htmlFor="oi-status" hint="Zum Abschließen nutze „Erledigt …“.">
              <Select id="oi-status" value={status} onChange={(e) => setStatus(e.target.value as EditableOpenItemStatus)}>
                {EditableOpenItemStatus.options.map((option) => (
                  <option key={option} value={option}>
                    {OPEN_ITEM_STATUS_LABELS[option]}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Thema" htmlFor="oi-topic">
            <Input id="oi-topic" value={topic} onChange={(e) => setTopic(e.target.value)} />
          </Field>
          <Field label="Projekt" htmlFor="oi-project">
            <Input id="oi-project" value={project} onChange={(e) => setProject(e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <ExtraSubjectFields idPrefix="open-item" {...extra} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button disabled={busy || !title.trim()} onClick={() => void save()} data-testid="open-item-save">
            Speichern
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
