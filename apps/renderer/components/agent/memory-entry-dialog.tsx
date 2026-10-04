'use client';

import { useState } from 'react';
import type { MemoryKind } from '@archivist/shared';
import { Field, Notice } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { call } from '@/lib/ipc';
import { WEEKDAY_NAMES } from '@/lib/labels';
import { useSettings } from '@/lib/use-settings';
import { useRun } from '@/lib/use-run';
import { dataOfDraft, THEN_FIELDS, WHEN_FIELDS, type MemoryDraft, type RuleForm, type WorkflowForm } from './memory-forms';

function RuleFields({ rule, onChange }: { rule: RuleForm; onChange: (rule: RuleForm) => void }) {
  const group = (title: string, fields: Array<[keyof RuleForm, string]>) => (
    <fieldset className="rounded-lg border p-3">
      <legend className="px-1 text-sm font-medium">{title}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map(([key, label]) => (
          <Field key={key} label={label} htmlFor={`memory-rule-${key}`}>
            <Input id={`memory-rule-${key}`} value={rule[key]} onChange={(e) => onChange({ ...rule, [key]: e.target.value })} />
          </Field>
        ))}
      </div>
    </fieldset>
  );
  return (
    <>
      {group('Wenn (mindestens eine Bedingung)', WHEN_FIELDS)}
      {group('Dann (mindestens eine Aktion)', THEN_FIELDS)}
    </>
  );
}

function WorkflowFields({ workflow, onChange }: { workflow: WorkflowForm; onChange: (workflow: WorkflowForm) => void }) {
  const { settings } = useSettings();
  const nightlyOff = settings?.agent.background.nightlyHour === null;
  return (
    <>
      <Field label="Schritte (einer pro Zeile)" htmlFor="memory-workflow-steps">
        <Textarea id="memory-workflow-steps" rows={4} value={workflow.steps} onChange={(e) => onChange({ ...workflow, steps: e.target.value })} />
      </Field>
      <Field
        label="Parameter (einer pro Zeile: Name: Beschreibung)"
        htmlFor="memory-workflow-parameters"
        hint="Im Schritt als {name} verwendbar, z. B. {jahr}. Fehlende Werte fragt Archivist ab."
      >
        <Textarea
          id="memory-workflow-parameters"
          rows={2}
          value={workflow.parameters}
          onChange={(e) => onChange({ ...workflow, parameters: e.target.value })}
        />
      </Field>
      <Field
        label="Automatisch ausführen"
        htmlFor="memory-workflow-weekday"
        hint="Geplante Abläufe laufen im Nachtlauf (Einstellungen → Agent → Hintergrund), nicht zu einer eigenen Uhrzeit. Ohne Parameter, und nachdem du den Ablauf einmal im Chat bestätigt hast."
      >
        <Select id="memory-workflow-weekday" value={workflow.weekday} onChange={(e) => onChange({ ...workflow, weekday: e.target.value })}>
          <option value="">nicht automatisch</option>
          {WEEKDAY_NAMES.map((day, i) => (
            <option key={day} value={i}>
              jeden {day} im Nachtlauf
            </option>
          ))}
        </Select>
      </Field>
      {workflow.weekday !== '' && nightlyOff && (
        <Notice tone="warning" data-testid="memory-workflow-nightly-off">
          Der Nachtlauf ist aus – dieser Ablauf läuft nicht von selbst. Wähle unter Einstellungen → Agent → Hintergrund → Nachtlauf eine Uhrzeit.
        </Notice>
      )}
    </>
  );
}

const KIND_OPTIONS: Array<[MemoryKind, string]> = [
  ['preference', 'Vorliebe'],
  ['fact', 'Wissen'],
  ['rule', 'Regel'],
  ['workflow', 'Ablauf'],
];

/** Creates or edits a learned entry; rules and workflows have form fields instead of raw JSON (#315). */
export function MemoryEntryDialog({ draft, onClose }: { draft: MemoryDraft; onClose: () => void }) {
  const [d, setD] = useState(draft);
  const { run, busy } = useRun();
  const data = dataOfDraft(d);
  const dataError = d.kind === 'correction' || data.ok ? null : data.error;
  const valid = d.name.trim() !== '' && d.content.trim() !== '' && data.ok;

  async function submit() {
    if (!data.ok) return;
    const payload = { name: d.name.trim(), content: d.content.trim(), ...(data.value ? { data: data.value } : {}) };
    const out = await run(
      () => (d.id ? call('agent:updateMemory', { id: d.id, ...payload }) : call('agent:saveMemory', { kind: d.kind, enabled: true, ...payload })),
      {
        success: 'Gespeichert.',
        errorTitle: 'Speichern fehlgeschlagen',
      },
    );
    if (out) onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="memory-dialog" className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{d.id ? 'Eintrag bearbeiten' : 'Neuer Eintrag'}</DialogTitle>
          <DialogDescription>Archivist gibt diesen Eintrag jedem Lauf mit, solange er eingeschaltet ist.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) void submit();
          }}
        >
          {!d.id && (
            <Field label="Art" htmlFor="memory-kind">
              <Select id="memory-kind" value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as MemoryKind })}>
                {KIND_OPTIONS.map(([kind, label]) => (
                  <option key={kind} value={kind}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Name" htmlFor="memory-name">
            <Input id="memory-name" value={d.name} maxLength={200} onChange={(e) => setD({ ...d, name: e.target.value })} data-testid="memory-name" />
          </Field>
          <Field
            label="Inhalt"
            htmlFor="memory-content"
            hint={d.kind === 'rule' || d.kind === 'workflow' ? 'In deinen Worten – Archivist zeigt das so im Chat.' : undefined}
          >
            <Textarea
              id="memory-content"
              rows={3}
              maxLength={4000}
              value={d.content}
              onChange={(e) => setD({ ...d, content: e.target.value })}
              data-testid="memory-content"
            />
          </Field>
          {d.kind === 'rule' && <RuleFields rule={d.rule} onChange={(rule) => setD({ ...d, rule })} />}
          {d.kind === 'workflow' && <WorkflowFields workflow={d.workflow} onChange={(workflow) => setD({ ...d, workflow })} />}
          {dataError && (
            <p className="text-xs text-destructive" role="alert" data-testid="memory-data-error">
              {dataError}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Abbrechen
            </Button>
            <Button type="submit" disabled={!valid || busy} data-testid="memory-save">
              Speichern
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
