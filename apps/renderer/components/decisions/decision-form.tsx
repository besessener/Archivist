'use client';

import { useState } from 'react';
import { DECISION_FIELD_LABELS, localDate, type DecisionField, type DecisionStatus } from '@archivist/shared';
import { Button } from '@/components/ui/button';
import { CheckboxField } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Field, Notice } from '@/components/common/states';
import { call } from '@/lib/ipc';
import { DECISION_STATUS_LABELS } from '@/lib/labels';
import { useRun } from '@/lib/use-run';
import type { DecisionRecord } from '@/lib/types';
import { nonEmpty, parseList } from '@/lib/utils';

function dayOf(v: string | null | undefined): string {
  return v ? localDate(v) : '';
}

export function DecisionFormDialog({
  open,
  onOpenChange,
  decision,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  decision: DecisionRecord | null;
  onSaved: (d: DecisionRecord) => void;
}) {
  const { run, busy } = useRun();
  const [title, setTitle] = useState(decision?.title ?? '');
  const [text, setText] = useState(decision?.decisionText ?? '');
  const [decidedAt, setDecidedAt] = useState(dayOf(decision?.decidedAt));
  const [topic, setTopic] = useState(decision?.topicName ?? '');
  const [project, setProject] = useState(decision?.projectName ?? '');
  const [participants, setParticipants] = useState((decision?.participants ?? []).join(', '));
  const [rationale, setRationale] = useState(decision?.rationale ?? '');
  const [consequences, setConsequences] = useState(decision?.consequences ?? '');
  const [alternatives, setAlternatives] = useState((decision?.alternatives ?? []).join('\n'));
  const [validFrom, setValidFrom] = useState(dayOf(decision?.validFrom));
  const [validUntil, setValidUntil] = useState(dayOf(decision?.validUntil));
  const [unknown, setUnknown] = useState<Set<DecisionField>>(new Set(decision?.unknownFields ?? []));
  const [draft, setDraft] = useState(decision?.status === 'draft');
  const [status, setStatus] = useState<DecisionStatus>(decision?.status ?? 'confirmed');

  const filled: Record<DecisionField, boolean> = {
    decisionText: text.trim().length > 0,
    decidedAt: decidedAt.length > 0,
    topic: topic.trim().length > 0,
    participants: parseList(participants).length > 0,
  };
  const missing = (Object.keys(filled) as DecisionField[]).filter((f) => !filled[f] && !unknown.has(f));
  const onlyTextMissing = missing.length === 1 && missing[0] === 'decisionText';
  const canSave = text.trim().length > 0 && !busy && !onlyTextMissing;
  const effectiveDraft = draft || missing.length > 0;

  function toggleUnknown(f: DecisionField, v: boolean) {
    setUnknown((prev) => {
      const next = new Set(prev);
      if (v) next.add(f);
      else next.delete(f);
      return next;
    });
  }

  const unknownBox = (f: DecisionField) => (
    <CheckboxField
      checked={unknown.has(f)}
      onCheckedChange={(v) => toggleUnknown(f, v === true)}
      label="unbekannt"
      className="text-xs"
      data-testid={`decision-unknown-${f}`}
    />
  );

  async function save() {
    const unknownFields = [...unknown].filter((f) => !filled[f]);
    const body = {
      ...(nonEmpty(title) ? { title: nonEmpty(title) } : {}),
      decisionText: text.trim(),
      decidedAt: decidedAt || null,
      topic: nonEmpty(topic) ?? null,
      project: nonEmpty(project) ?? null,
      participants: parseList(participants),
      rationale: nonEmpty(rationale) ?? null,
      consequences: nonEmpty(consequences) ?? null,
      alternatives: alternatives
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
      validFrom: validFrom || null,
      validUntil: validUntil || null,
      unknownFields,
      asDraft: effectiveDraft,
    };
    const out = await run(
      () =>
        decision
          ? call('decisions:update', { id: decision.id, patch: { ...body, status: effectiveDraft ? 'draft' : status === 'draft' ? 'confirmed' : status } })
          : call('decisions:create', body),
      { success: decision ? 'Entscheidung gespeichert.' : effectiveDraft ? 'Entwurf gespeichert.' : 'Entscheidung angelegt.' },
    );
    if (out) {
      onSaved(out);
      onOpenChange(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="decision-form">
        <DialogHeader>
          <DialogTitle>{decision ? 'Entscheidung bearbeiten' : 'Entscheidung festhalten'}</DialogTitle>
          <DialogDescription>
            Felder mit <span aria-hidden>*</span>
            <span className="sr-only">Stern</span> gehören zu einer vollständigen Entscheidung. Wenn Sie etwas nicht wissen, markieren Sie es als „unbekannt“ –
            dann wird nicht gefragt.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Kurztitel (optional)" htmlFor="d-title" className="sm:col-span-2">
            <Input id="d-title" value={title} onChange={(e) => setTitle(e.target.value)} data-testid="decision-title" />
          </Field>
          <Field label={`${DECISION_FIELD_LABELS.decisionText} *`} htmlFor="d-text" className="sm:col-span-2">
            <Textarea
              id="d-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Was wurde entschieden?"
              data-testid="decision-text"
              required
            />
          </Field>
          <Field label={`${DECISION_FIELD_LABELS.decidedAt} *`} htmlFor="d-date">
            <Input
              id="d-date"
              type="date"
              value={decidedAt}
              disabled={unknown.has('decidedAt')}
              onChange={(e) => setDecidedAt(e.target.value)}
              data-testid="decision-date"
            />
            {unknownBox('decidedAt')}
          </Field>
          <Field label={`${DECISION_FIELD_LABELS.topic} *`} htmlFor="d-topic">
            <Input id="d-topic" value={topic} disabled={unknown.has('topic')} onChange={(e) => setTopic(e.target.value)} data-testid="decision-topic" />
            {unknownBox('topic')}
          </Field>
          <Field label={`${DECISION_FIELD_LABELS.participants} *`} htmlFor="d-people" hint="Mehrere Namen mit Komma trennen." className="sm:col-span-2">
            <Input
              id="d-people"
              value={participants}
              disabled={unknown.has('participants')}
              onChange={(e) => setParticipants(e.target.value)}
              data-testid="decision-participants"
            />
            {unknownBox('participants')}
          </Field>
          <Field label="Projekt" htmlFor="d-project">
            <Input id="d-project" value={project} onChange={(e) => setProject(e.target.value)} />
          </Field>
          <Field label="Begründung" htmlFor="d-why">
            <Input id="d-why" value={rationale} onChange={(e) => setRationale(e.target.value)} />
          </Field>
          <Field label="Auswirkungen" htmlFor="d-cons" className="sm:col-span-2">
            <Textarea id="d-cons" value={consequences} onChange={(e) => setConsequences(e.target.value)} />
          </Field>
          <Field label="Alternativen" htmlFor="d-alt" hint="Eine pro Zeile." className="sm:col-span-2">
            <Textarea id="d-alt" value={alternatives} onChange={(e) => setAlternatives(e.target.value)} />
          </Field>
          <Field label="Gültig ab" htmlFor="d-from">
            <Input id="d-from" type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
          </Field>
          <Field label="Gültig bis" htmlFor="d-until">
            <Input id="d-until" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
          </Field>
          {decision && (
            <Field label="Status" htmlFor="d-status">
              <Select id="d-status" value={status} onChange={(e) => setStatus(e.target.value as DecisionStatus)}>
                {(Object.keys(DECISION_STATUS_LABELS) as DecisionStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {DECISION_STATUS_LABELS[s]}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        {missing.length > 0 && !onlyTextMissing && (
          <Notice tone="warning" title="Noch nicht vollständig" data-testid="decision-missing">
            Es fehlt: {missing.map((f) => DECISION_FIELD_LABELS[f]).join(', ')}. Die Entscheidung wird als Entwurf gespeichert, bis Sie das ergänzen oder als
            „unbekannt“ markieren.
          </Notice>
        )}
        <CheckboxField
          checked={effectiveDraft}
          disabled={missing.length > 0}
          onCheckedChange={(v) => setDraft(v === true)}
          label="Als Entwurf speichern"
          data-testid="decision-draft"
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button disabled={!canSave} onClick={() => void save()} data-testid="decision-save">
            {effectiveDraft ? 'Als Entwurf speichern' : 'Speichern'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
