'use client';

import { useState } from 'react';
import type { KnowledgeCreateResult } from '@archivist/shared';
import { MARKDOWN_HINT } from '@/components/common/markdown';
import { Field } from '@/components/common/states';
import { UnknownWikiLinks, WikiTextarea } from '@/components/knowledge/wiki-textarea';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { call } from '@/lib/ipc';
import { ENTITY_TYPE_LABELS } from '@/lib/nav';
import { useRun } from '@/lib/use-run';

const CREATABLE = ['topic', 'project', 'case', 'person', 'event', 'note'] as const;
type Creatable = (typeof CREATABLE)[number];

export function CreateEntityDialog({
  open,
  onOpenChange,
  onResult,
  onPickEvent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResult: (result: KnowledgeCreateResult) => void;
  onPickEvent: (title: string) => void;
}) {
  const [type, setType] = useState<Exclude<Creatable, 'event'>>('topic');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const { run, busy } = useRun();
  const label = ENTITY_TYPE_LABELS[type];
  const isNote = type === 'note';

  const create = async () => {
    const result = await run(() =>
      call('knowledge:createEntity', { type, name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) }),
    );
    if (!result) return;
    setName('');
    setDescription('');
    onOpenChange(false);
    onResult(result);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Neu anlegen</DialogTitle>
          <DialogDescription>Lege ein neues Thema, Projekt, einen Vorgang, eine Person, eine Notiz oder ein Ereignis (mit Datum) an.</DialogDescription>
        </DialogHeader>
        <Field label="Art" htmlFor="new-entity-type">
          <Select
            id="new-entity-type"
            value={type}
            onChange={(e) => {
              const next = e.target.value as Creatable;
              // Events need a date: hand over to the same dialog the timeline uses.
              if (next === 'event') onPickEvent(name.trim());
              else setType(next);
            }}
            data-testid="knowledge-new-type"
          >
            {CREATABLE.map((t) => (
              <option key={t} value={t}>
                {ENTITY_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={isNote ? 'Titel' : 'Name'} htmlFor="new-entity-name">
          <Input
            id="new-entity-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={isNote ? 'Titel der Notiz' : `Name des Eintrags (${label})`}
            data-testid="knowledge-new-name"
          />
        </Field>
        <Field
          label={isNote ? 'Inhalt (optional)' : 'Beschreibung (optional)'}
          htmlFor="new-entity-desc"
          hint={isNote ? `${MARKDOWN_HINT} Mit [[Name]] verlinkst du andere Einträge.` : MARKDOWN_HINT}
        >
          {isNote ? (
            <WikiTextarea id="new-entity-desc" value={description} onChange={setDescription} data-testid="knowledge-new-description" />
          ) : (
            <Textarea id="new-entity-desc" value={description} onChange={(e) => setDescription(e.target.value)} data-testid="knowledge-new-description" />
          )}
        </Field>
        {isNote && <UnknownWikiLinks text={description} />}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button disabled={busy || !name.trim()} data-testid="knowledge-new-save" onClick={create}>
            Anlegen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
