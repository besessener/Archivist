'use client';

import { useState } from 'react';
import {
  DECISION_FIELD_LABELS,
  isEditableDecisionStatus,
  localDate,
  type DecisionField,
  type DecisionStatus,
  type EditableDecisionStatus,
} from '@archivist/shared';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { ExtraSubjectFields, useExtraSubjects } from '@/components/common/extra-subjects';
import { MARKDOWN_HINT } from '@/components/common/markdown';
import { Field, Notice } from '@/components/common/states';
import {
  DecisionStatusField,
  SupersededByField,
  isStatusLocked,
  pendingCriticalStatus,
  type CriticalStatus,
} from '@/components/decisions/decision-status-field';
import { Button } from '@/components/ui/button';
import { CheckboxField } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { call } from '@/lib/ipc';
import { useRun } from '@/lib/use-run';
import type { DecisionRecord } from '@/lib/types';
import { nonEmpty, parseList, withMembership } from '@/lib/utils';

function dayOf(value: string | null | undefined): string {
  return value ? localDate(value) : '';
}

/** The status sent with an edit; a pending supersede/revoke goes its own confirmed way instead. */
function editStatusFor({
  locked,
  pendingCritical,
  draft,
  status,
}: {
  locked: boolean;
  pendingCritical: CriticalStatus | null;
  draft: boolean;
  status: DecisionStatus;
}): EditableDecisionStatus | undefined {
  if (locked || pendingCritical) return undefined;
  if (draft) return 'draft';
  return status === 'draft' || !isEditableDecisionStatus(status) ? 'confirmed' : status;
}

function successMessage({ isNew, draft, pendingCritical }: { isNew: boolean; draft: boolean; pendingCritical: CriticalStatus | null }): string {
  if (isNew) return draft ? 'Entwurf gespeichert.' : 'Entscheidung angelegt.';
  if (pendingCritical === 'revoked') return 'Entscheidung widerrufen.';
  if (pendingCritical === 'superseded') return 'Entscheidung als ersetzt markiert.';
  return 'Entscheidung gespeichert.';
}

export function DecisionFormDialog({
  open,
  onOpenChange,
  decision,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  decision: DecisionRecord | null;
  onSaved: (decision: DecisionRecord) => void;
}) {
  const { run, busy } = useRun();
  const [title, setTitle] = useState(decision?.title ?? '');
  const [text, setText] = useState(decision?.decisionText ?? '');
  const [decidedAt, setDecidedAt] = useState(dayOf(decision?.decidedAt));
  const [topic, setTopic] = useState(decision?.topicName ?? '');
  const [project, setProject] = useState(decision?.projectName ?? '');
  const extra = useExtraSubjects(decision?.id, { open });
  const [participants, setParticipants] = useState((decision?.participants ?? []).join(', '));
  const [rationale, setRationale] = useState(decision?.rationale ?? '');
  const [consequences, setConsequences] = useState(decision?.consequences ?? '');
  const [alternatives, setAlternatives] = useState((decision?.alternatives ?? []).join('\n'));
  const [validFrom, setValidFrom] = useState(dayOf(decision?.validFrom));
  const [validUntil, setValidUntil] = useState(dayOf(decision?.validUntil));
  const [unknown, setUnknown] = useState<Set<DecisionField>>(new Set(decision?.unknownFields ?? []));
  const [draft, setDraft] = useState(decision?.status === 'draft');
  const [status, setStatus] = useState<DecisionStatus>(decision?.status ?? 'confirmed');
  const [supersededBy, setSupersededBy] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const statusLocked = isStatusLocked(decision);
  const pendingCritical = pendingCriticalStatus(decision, status);

  const filled: Record<DecisionField, boolean> = {
    decisionText: text.trim().length > 0,
    decidedAt: decidedAt.length > 0,
    topic: topic.trim().length > 0,
    participants: parseList(participants).length > 0,
  };
  const missing = (Object.keys(filled) as DecisionField[]).filter((field) => !filled[field] && !unknown.has(field));
  const onlyTextMissing = missing.length === 1 && missing[0] === 'decisionText';
  const canSave = text.trim().length > 0 && !busy && !onlyTextMissing && (pendingCritical !== 'superseded' || supersededBy !== '');
  const effectiveDraft = draft || missing.length > 0;
  // before superseding/revoking, the fields are only saved if they were edited (keeps the undo entries minimal)
  const formState = JSON.stringify([
    title,
    text,
    decidedAt,
    topic,
    project,
    participants,
    rationale,
    consequences,
    alternatives,
    validFrom,
    validUntil,
    [...unknown].sort(),
    draft,
  ]);
  const [initialFormState] = useState(formState);
  const fieldsChanged = formState !== initialFormState;

  // the status select and the draft checkbox stay in step, so neither silently overrides the other on save
  function changeStatus(next: DecisionStatus) {
    setStatus(next);
    if (isEditableDecisionStatus(next)) setDraft(next === 'draft');
  }

  function changeDraft(checked: boolean) {
    setDraft(checked);
    if (!decision || !isEditableDecisionStatus(status)) return;
    if (checked) setStatus('draft');
    else if (status === 'draft') setStatus('confirmed');
  }

  function setFieldUnknown(field: DecisionField, isUnknown: boolean) {
    setUnknown((previous) => withMembership(previous, { value: field, present: isUnknown }));
  }

  const unknownBox = (field: DecisionField) => (
    <CheckboxField
      checked={unknown.has(field)}
      onCheckedChange={(checked) => setFieldUnknown(field, checked === true)}
      label="unbekannt"
      className="text-xs"
      data-testid={`decision-unknown-${field}`}
    />
  );

  async function save() {
    // superseding/revoking is a stage-2 action: ask first, then use the confirmed path (with undo entry)
    if (pendingCritical) setConfirmOpen(true);
    else await persist();
  }

  async function persist() {
    const unknownFields = [...unknown].filter((field) => !filled[field]);
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
        .map((alternative) => alternative.trim())
        .filter(Boolean),
      validFrom: validFrom || null,
      validUntil: validUntil || null,
      unknownFields,
      asDraft: effectiveDraft,
    };
    const editStatus = editStatusFor({ locked: statusLocked, pendingCritical, draft: effectiveDraft, status });
    const saved = await run(
      async () => {
        if (!decision) {
          const created = await call('decisions:create', body);
          await extra.save(created.id);
          return created;
        }
        const updated =
          pendingCritical && !fieldsChanged
            ? decision
            : await call('decisions:update', { id: decision.id, patch: { ...body, ...(editStatus ? { status: editStatus } : {}) } });
        // after the main topic/project, so a new main one is never stored as a further one as well
        await extra.save(decision.id);
        if (pendingCritical === 'revoked') return call('decisions:revoke', { id: decision.id, confirmed: true });
        if (pendingCritical === 'superseded')
          return (await call('decisions:supersede', { oldDecisionId: decision.id, newDecisionId: supersededBy, confirmed: true })).old;
        return updated;
      },
      { success: successMessage({ isNew: !decision, draft: effectiveDraft, pendingCritical }) },
    );
    setConfirmOpen(false);
    if (!saved) return;
    onSaved(saved);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="decision-form">
        <DialogHeader>
          <DialogTitle>{decision ? 'Entscheidung bearbeiten' : 'Entscheidung festhalten'}</DialogTitle>
          <DialogDescription>
            Felder mit <span aria-hidden>*</span>
            <span className="sr-only">Stern</span> gehören zu einer vollständigen Entscheidung. Wenn du etwas nicht weißt, markiere es als „unbekannt“ – dann
            wird nicht gefragt.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Kurztitel (optional)" htmlFor="d-title" className="sm:col-span-2">
            <Input id="d-title" value={title} onChange={(e) => setTitle(e.target.value)} data-testid="decision-title" />
          </Field>
          <Field label={`${DECISION_FIELD_LABELS.decisionText} *`} htmlFor="d-text" hint={MARKDOWN_HINT} className="sm:col-span-2">
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
          <div className="sm:col-span-2">
            <ExtraSubjectFields idPrefix="decision" {...extra} />
          </div>
          <Field label="Begründung" htmlFor="d-why">
            <Input id="d-why" value={rationale} onChange={(e) => setRationale(e.target.value)} />
          </Field>
          <Field label="Auswirkungen" htmlFor="d-cons" hint={MARKDOWN_HINT} className="sm:col-span-2">
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
          {decision && <DecisionStatusField decision={decision} status={status} onStatusChange={changeStatus} />}
          {pendingCritical === 'superseded' && decision && (
            <SupersededByField decision={decision} open={open} value={supersededBy} onChange={setSupersededBy} />
          )}
        </div>
        {missing.length > 0 && !onlyTextMissing && (
          <Notice tone="warning" title="Noch nicht vollständig" data-testid="decision-missing">
            Es fehlt: {missing.map((field) => DECISION_FIELD_LABELS[field]).join(', ')}. Die Entscheidung wird als Entwurf gespeichert, bis du das ergänzt oder
            als „unbekannt“ markieren.
          </Notice>
        )}
        <CheckboxField
          checked={effectiveDraft}
          disabled={missing.length > 0}
          onCheckedChange={(checked) => changeDraft(checked === true)}
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
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title={pendingCritical === 'revoked' ? 'Entscheidung widerrufen?' : 'Entscheidung als ersetzt markieren?'}
          description={
            pendingCritical === 'revoked'
              ? `„${title.trim() || decision?.title || 'Entscheidung'}“ gilt danach nicht mehr.`
              : `„${title.trim() || decision?.title || 'Entscheidung'}“ wird durch die gewählte neuere Entscheidung ersetzt und gilt danach nicht mehr.`
          }
          confirmLabel={pendingCritical === 'revoked' ? 'Widerrufen' : 'Als ersetzt markieren'}
          destructive={pendingCritical === 'revoked'}
          confirmTestId="decision-status-confirm"
          onConfirm={persist}
        >
          <p className="text-sm text-muted-foreground">
            {fieldsChanged ? 'Deine übrigen Änderungen werden vorher gespeichert. ' : ''}Das lässt sich unter Einstellungen → Änderungsprotokoll rückgängig
            machen.
          </p>
        </ConfirmDialog>
      </DialogContent>
    </Dialog>
  );
}
