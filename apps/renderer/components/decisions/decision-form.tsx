'use client';

import { useState } from 'react';
import { DECISION_FIELD_LABELS, EditableDecisionStatus, isEditableDecisionStatus, localDate, type DecisionField, type DecisionStatus } from '@archivist/shared';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { Button } from '@/components/ui/button';
import { CheckboxField } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Field, Notice } from '@/components/common/states';
import { call } from '@/lib/ipc';
import { formatLongDate } from '@/lib/format';
import { DECISION_STATUS_LABELS } from '@/lib/labels';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import type { DecisionRecord } from '@/lib/types';
import { nonEmpty, parseList } from '@/lib/utils';

/** Statuses that need an explicit confirmation (stage 2) and get an undo entry; never sent via `decisions:update`. */
type CriticalStatus = 'superseded' | 'revoked';
const isCritical = (s: DecisionStatus): s is CriticalStatus => s === 'superseded' || s === 'revoked';

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
  const [supersededBy, setSupersededBy] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  // superseded/revoked decisions keep their status here; the way back is undo in the audit log
  const statusLocked = decision !== null && !isEditableDecisionStatus(decision.status);
  const pendingCritical: CriticalStatus | null = decision && !statusLocked && isCritical(status) ? status : null;
  const others = useQuery('decisions:list', {}, { scopes: ['decisions'], enabled: open && pendingCritical === 'superseded' });

  const filled: Record<DecisionField, boolean> = {
    decisionText: text.trim().length > 0,
    decidedAt: decidedAt.length > 0,
    topic: topic.trim().length > 0,
    participants: parseList(participants).length > 0,
  };
  const missing = (Object.keys(filled) as DecisionField[]).filter((f) => !filled[f] && !unknown.has(f));
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
    // superseding/revoking is a stage-2 action: ask first, then use the confirmed path (with undo entry)
    if (pendingCritical) setConfirmOpen(true);
    else await persist();
  }

  async function persist() {
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
    const editStatus: EditableDecisionStatus | undefined =
      statusLocked || pendingCritical ? undefined : effectiveDraft ? 'draft' : status === 'draft' || !isEditableDecisionStatus(status) ? 'confirmed' : status;
    const out = await run(
      async () => {
        if (!decision) return call('decisions:create', body);
        const saved =
          pendingCritical && !fieldsChanged
            ? decision
            : await call('decisions:update', { id: decision.id, patch: { ...body, ...(editStatus ? { status: editStatus } : {}) } });
        if (pendingCritical === 'revoked') return call('decisions:revoke', { id: decision.id, confirmed: true });
        if (pendingCritical === 'superseded')
          return (await call('decisions:supersede', { oldDecisionId: decision.id, newDecisionId: supersededBy, confirmed: true })).old;
        return saved;
      },
      {
        success: !decision
          ? effectiveDraft
            ? 'Entwurf gespeichert.'
            : 'Entscheidung angelegt.'
          : pendingCritical === 'revoked'
            ? 'Entscheidung widerrufen.'
            : pendingCritical === 'superseded'
              ? 'Entscheidung als ersetzt markiert.'
              : 'Entscheidung gespeichert.',
      },
    );
    setConfirmOpen(false);
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
            <span className="sr-only">Stern</span> gehören zu einer vollständigen Entscheidung. Wenn du etwas nicht weißt, markiere es als „unbekannt“ – dann
            wird nicht gefragt.
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
            <Field
              label="Status"
              htmlFor="d-status"
              hint={
                statusLocked
                  ? 'Rückgängig machen kannst du das unter Einstellungen → Änderungsprotokoll.'
                  : pendingCritical
                    ? 'Wird erst nach deiner Bestätigung übernommen und lässt sich im Änderungsprotokoll rückgängig machen.'
                    : undefined
              }
            >
              <Select
                id="d-status"
                value={status}
                disabled={statusLocked}
                onChange={(e) => setStatus(e.target.value as DecisionStatus)}
                data-testid="decision-status"
              >
                {statusLocked ? (
                  <option value={decision.status}>{DECISION_STATUS_LABELS[decision.status]}</option>
                ) : (
                  <>
                    {EditableDecisionStatus.options.map((s) => (
                      <option key={s} value={s}>
                        {DECISION_STATUS_LABELS[s]}
                      </option>
                    ))}
                    <option value="superseded">{DECISION_STATUS_LABELS.superseded} …</option>
                    <option value="revoked">{DECISION_STATUS_LABELS.revoked} …</option>
                  </>
                )}
              </Select>
            </Field>
          )}
          {pendingCritical === 'superseded' && decision && (
            <Field label="Ersetzt durch" htmlFor="d-superseded-by">
              <Select id="d-superseded-by" value={supersededBy} onChange={(e) => setSupersededBy(e.target.value)} data-testid="decision-superseded-by">
                <option value="">Neuere Entscheidung wählen …</option>
                {(others.data ?? [])
                  .filter((x) => x.id !== decision.id)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {(x.title || x.decisionText).slice(0, 80)} ({formatLongDate(x.decidedAt, 'ohne Datum')})
                    </option>
                  ))}
              </Select>
            </Field>
          )}
        </div>
        {missing.length > 0 && !onlyTextMissing && (
          <Notice tone="warning" title="Noch nicht vollständig" data-testid="decision-missing">
            Es fehlt: {missing.map((f) => DECISION_FIELD_LABELS[f]).join(', ')}. Die Entscheidung wird als Entwurf gespeichert, bis du das ergänzt oder als
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
