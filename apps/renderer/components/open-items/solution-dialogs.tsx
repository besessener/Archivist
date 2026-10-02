'use client';

import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { IpcOutput } from '@archivist/shared';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CheckboxField } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { plural } from '@/lib/format';
import { call } from '@/lib/ipc';
import { ENTITY_TYPE_LABELS } from '@/lib/nav';
import type { OpenItemRecord } from '@/lib/types';
import { useRun } from '@/lib/use-run';
import { withMembership } from '@/lib/utils';

export type Preview = IpcOutput<'openItems:solutionPreview'>;
type Claim = NonNullable<OpenItemRecord['solution']>['nextSteps'][number];

/** Mode „vorher fragen“ (ask first): shows what is sent to the LLM. */
export function PreviewDialog({ preview, onClose, onConfirm }: { preview: Preview | null; onClose: () => void; onConfirm: () => void }) {
  const titleOnly = preview?.sources.filter((source) => !source.contentIncluded).length ?? 0;
  return (
    <Dialog open={preview !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl" data-testid="solution-preview">
        <DialogHeader>
          <DialogTitle>Lösungsvorschlag erzeugen?</DialogTitle>
          <DialogDescription>Folgende Inhalte werden an das LLM gesendet …</DialogDescription>
        </DialogHeader>
        {preview && (
          <div className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto text-sm">
            <div>
              <h3 className="mb-1 font-semibold">Der offene Punkt</h3>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                {preview.itemFields.map((field) => (
                  <div key={field.label} className="contents">
                    <dt className="text-muted-foreground">{field.label}</dt>
                    <dd className="whitespace-pre-line">{field.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <div>
              <h3 className="mb-1 font-semibold">Quellen aus dem Archiv ({preview.sources.length})</h3>
              {preview.sources.length === 0 ? (
                <p className="text-muted-foreground">Keine passenden Quellen gefunden – es wird nur der Punkt gesendet.</p>
              ) : (
                <ul className="flex flex-col gap-1" data-testid="solution-preview-sources">
                  {preview.sources.map((source) => (
                    <li key={source.ref} className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">{source.ref}</span>
                      <Badge variant="outline">{ENTITY_TYPE_LABELS[source.type]}</Badge>
                      <span>{source.title}</span>
                      {!source.contentIncluded && <Badge variant="warning">nur Titel</Badge>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {titleOnly > 0 && `${plural(titleOnly, ['ausgeschlossenes Dokument wird', 'ausgeschlossene Dokumente werden'])} nur mit Titel gesendet. `}
              Geheimnisse wie Passwörter oder API-Keys werden vor dem Senden maskiert; die Übertragung erscheint im Übertragungsprotokoll.
            </p>
            {!preview.available && preview.blockedReason && <p className="text-sm text-destructive">{preview.blockedReason}</p>}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Abbrechen
          </Button>
          <Button disabled={!preview?.available} onClick={onConfirm} data-testid="solution-confirm">
            <Sparkles aria-hidden /> Senden und Vorschlag erzeugen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Create steps as separate open items (selection + confirmation). */
export function StepsDialog({
  open,
  item,
  steps,
  onClose,
  onDone,
}: {
  open: boolean;
  item: OpenItemRecord;
  steps: Claim[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { run } = useRun();
  const [selected, setSelected] = useState<Set<number>>(() => new Set(steps.map((_, i) => i)));
  const count = selected.size;
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(open) => !open && onClose()}
      title="Schritte als offene Punkte anlegen?"
      description={`Jeder ausgewählte Schritt wird ein eigener offener Punkt (Thema und Projekt wie „${item.title}“).`}
      confirmLabel={count ? `${plural(count, ['Punkt', 'Punkte'])} anlegen` : 'Nichts ausgewählt'}
      confirmTestId="solution-steps-confirm"
      onConfirm={async () => {
        if (!count) return;
        const created = await run(
          () => call('openItems:applySolution', { target: 'items', id: item.id, stepIndexes: [...selected].sort((a, b) => a - b), confirmed: true }),
          { success: `${plural(count, ['offener Punkt', 'offene Punkte'])} angelegt.` },
        );
        if (!created) return;
        onDone();
        onClose();
      }}
    >
      <div className="flex flex-col gap-2" data-testid="solution-steps">
        {steps.map((step, i) => (
          <CheckboxField
            key={i}
            checked={selected.has(i)}
            onCheckedChange={(checked) => setSelected((previous) => withMembership(previous, { value: i, present: checked === true }))}
            label={
              <>
                {step.text}
                {step.uncertain && (
                  <Badge variant="warning" className="ml-1">
                    unbelegt
                  </Badge>
                )}
              </>
            }
          />
        ))}
      </div>
    </ConfirmDialog>
  );
}
