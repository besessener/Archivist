'use client';

import { useRef, useState } from 'react';
import { FilePlus2, ListPlus, Loader2, Sparkles, StickyNote, X } from 'lucide-react';
import type { IpcOutput } from '@archivist/shared';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EntityChip } from '@/components/common/entity-chip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CheckboxField } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatDateTime, plural } from '@/lib/format';
import { call } from '@/lib/ipc';
import { ENTITY_TYPE_LABELS } from '@/lib/nav';
import { useToast } from '@/lib/toast';
import type { OpenItemRecord } from '@/lib/types';
import { useRun } from '@/lib/use-run';

type Preview = IpcOutput<'openItems:solutionPreview'>;
type Solution = NonNullable<OpenItemRecord['solution']>;
type Claim = Solution['nextSteps'][number];

export interface SolutionSectionProps {
  item: OpenItemRecord;
  mode: 'auto' | 'confirm' | 'local_only';
  llmConfigured: boolean;
  onChanged: () => void;
}

/**
 * „Lösungsvorschlag generieren“ für einen aktiven offenen Punkt: Aktion (mit Datenschutz-Abfrage, Ladezustand und Abbruch)
 * sowie Anzeige und Übernahme des gespeicherten Vorschlags. Steht in der Aktionsleiste; Hinweise und Vorschlag belegen eine eigene Zeile.
 */
export function SolutionSection({ item, mode, llmConfigured, onChanged }: SolutionSectionProps) {
  const { toast, reportError } = useToast();
  const { run, busy } = useRun();
  const [generating, setGenerating] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [stepsOpen, setStepsOpen] = useState(false);
  /** Zähler je Erzeugung: Ergebnisse abgebrochener Läufe werden ignoriert. */
  const runId = useRef(0);
  const hintId = `solution-hint-${item.id}`;

  const blocked =
    mode === 'local_only'
      ? 'Im Datenschutzmodus „nur lokal“ werden keine Inhalte an das LLM gesendet – Lösungsvorschläge sind deshalb deaktiviert.'
      : !llmConfigured
        ? 'Das LLM ist nicht konfiguriert. Hinterlege Base URL, Modell und API-Key in den Einstellungen.'
        : null;

  async function generate(confirmed: boolean) {
    const id = ++runId.current;
    setGenerating(true);
    try {
      await call('openItems:generateSolution', { id: item.id, confirmed });
      if (id !== runId.current) return;
      toast({ variant: 'success', title: 'Lösungsvorschlag erstellt.' });
      onChanged();
    } catch (err) {
      if (id === runId.current) reportError(err, undefined, 'Lösungsvorschlag nicht möglich – es wurde nichts geändert');
    } finally {
      if (id === runId.current) setGenerating(false);
    }
  }

  async function start() {
    if (mode !== 'confirm') {
      void generate(false);
      return;
    }
    const p = await run(() => call('openItems:solutionPreview', { id: item.id }));
    if (p) setPreview(p);
  }

  async function cancel() {
    runId.current += 1;
    setGenerating(false);
    try {
      await call('openItems:cancelSolution', { id: item.id });
    } catch {
      /* das Ergebnis wird ohnehin verworfen */
    }
    toast({ variant: 'info', title: 'Erzeugung abgebrochen – es wurde nichts geändert.' });
  }

  async function apply(target: 'description' | 'note') {
    const out = await run(() => call('openItems:applySolution', { target, id: item.id }), {
      success: target === 'description' ? 'Vorschlag zur Beschreibung hinzugefügt.' : 'Vorschlag als Notiz gespeichert.',
    });
    if (out) onChanged();
  }

  return (
    <>
      {generating ? (
        <span role="status" className="inline-flex items-center gap-2 text-sm text-muted-foreground" data-testid="solution-loading">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Lösungsvorschlag wird erstellt …
          <Button size="sm" variant="ghost" onClick={() => void cancel()} data-testid="solution-cancel">
            <X aria-hidden /> Abbrechen
          </Button>
        </span>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={blocked !== null || busy}
          aria-describedby={blocked ? hintId : undefined}
          onClick={() => void start()}
          data-testid="solution-generate"
        >
          <Sparkles aria-hidden /> {item.solution ? 'Lösungsvorschlag neu generieren' : 'Lösungsvorschlag generieren'}
        </Button>
      )}
      {blocked && (
        <p id={hintId} className="basis-full text-xs text-muted-foreground" data-testid="solution-blocked">
          {blocked}
        </p>
      )}
      {item.solution && (
        <SolutionPanel
          solution={item.solution}
          busy={busy || generating}
          onDescription={() => void apply('description')}
          onNote={() => void apply('note')}
          onSteps={() => setStepsOpen(true)}
        />
      )}
      <PreviewDialog
        preview={preview}
        onClose={() => setPreview(null)}
        onConfirm={() => {
          setPreview(null);
          void generate(true);
        }}
      />
      {item.solution && (
        <StepsDialog
          key={`${item.solution.generatedAt}-${stepsOpen}`}
          open={stepsOpen}
          item={item}
          steps={item.solution.nextSteps}
          onClose={() => setStepsOpen(false)}
          onDone={onChanged}
        />
      )}
    </>
  );
}

function Refs({ claim }: { claim: Pick<Claim, 'sourceRefs' | 'uncertain'> }) {
  if (claim.uncertain)
    return (
      <Badge variant="warning" className="ml-1 align-middle" title="Kein gültiger Quellenbeleg – unsicher" data-testid="solution-unbacked">
        unbelegt
      </Badge>
    );
  return <span className="ml-1 text-xs text-muted-foreground">[{(claim.sourceRefs ?? []).join(', ')}]</span>;
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h4>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function SolutionPanel({
  solution: s,
  busy,
  onDescription,
  onNote,
  onSteps,
}: {
  solution: Solution;
  busy: boolean;
  onDescription: () => void;
  onNote: () => void;
  onSteps: () => void;
}) {
  const sources = s.sources ?? [];
  const shown = sources.some((x) => x.used) ? sources.filter((x) => x.used) : sources;
  return (
    <section aria-label="Lösungsvorschlag" className="basis-full rounded-lg border bg-muted/40 p-3 text-sm" data-testid="solution-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 font-semibold">
          <Sparkles className="size-4 text-primary" aria-hidden /> Lösungsvorschlag
        </h3>
        <span className="text-xs text-muted-foreground" data-testid="solution-meta">
          vom {formatDateTime(s.generatedAt)} · Modell: {s.model}
        </span>
      </div>
      <p className="mt-2">
        {s.assessment}
        <Refs claim={{ sourceRefs: s.assessmentSourceRefs ?? [], uncertain: s.assessmentUncertain }} />
      </p>
      {s.nextSteps.length > 0 && (
        <Block title="Nächste Schritte">
          <ol className="list-decimal space-y-1 pl-5">
            {s.nextSteps.map((c, i) => (
              <li key={i}>
                {c.text}
                <Refs claim={c} />
                {c.detail && <span className="block text-xs text-muted-foreground">{c.detail}</span>}
              </li>
            ))}
          </ol>
        </Block>
      )}
      {s.openQuestions.length > 0 && (
        <Block title="Offene Fragen / fehlende Informationen">
          <ul className="list-disc space-y-1 pl-5">
            {s.openQuestions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </Block>
      )}
      {s.risks.length > 0 && (
        <Block title="Risiken">
          <ul className="list-disc space-y-1 pl-5">
            {s.risks.map((c, i) => (
              <li key={i}>
                {c.text}
                <Refs claim={c} />
              </li>
            ))}
          </ul>
        </Block>
      )}
      {s.uncertainties.length > 0 && (
        <Block title="Unsicherheiten">
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            {s.uncertainties.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </Block>
      )}
      {shown.length > 0 && (
        <Block title="Verwendete Quellen">
          <div className="flex flex-wrap gap-1.5">
            {shown.map((src) => (
              <EntityChip
                key={src.ref}
                type={src.type}
                id={src.id}
                label={`${src.ref} ${src.title}`}
                detail={src.contentIncluded ? null : 'nur Titel gesendet'}
              />
            ))}
          </div>
        </Block>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={onDescription} data-testid="solution-apply-description">
          <FilePlus2 aria-hidden /> Zur Beschreibung hinzufügen
        </Button>
        <Button size="sm" variant="outline" disabled={busy || s.nextSteps.length === 0} onClick={onSteps} data-testid="solution-apply-items">
          <ListPlus aria-hidden /> Schritte als offene Punkte …
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onNote} data-testid="solution-apply-note">
          <StickyNote aria-hidden /> Als Notiz speichern
        </Button>
      </div>
    </section>
  );
}

/** Modus „vorher fragen“: zeigt, was an das LLM gesendet wird. */
function PreviewDialog({ preview, onClose, onConfirm }: { preview: Preview | null; onClose: () => void; onConfirm: () => void }) {
  const titleOnly = preview?.sources.filter((s) => !s.contentIncluded).length ?? 0;
  return (
    <Dialog open={preview !== null} onOpenChange={(o) => !o && onClose()}>
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
                {preview.itemFields.map((f) => (
                  <div key={f.label} className="contents">
                    <dt className="text-muted-foreground">{f.label}</dt>
                    <dd className="whitespace-pre-line">{f.value}</dd>
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
                  {preview.sources.map((s) => (
                    <li key={s.ref} className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">{s.ref}</span>
                      <Badge variant="outline">{ENTITY_TYPE_LABELS[s.type]}</Badge>
                      <span>{s.title}</span>
                      {!s.contentIncluded && <Badge variant="warning">nur Titel</Badge>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {titleOnly > 0 && `${plural(titleOnly, 'ausgeschlossenes Dokument wird', 'ausgeschlossene Dokumente werden')} nur mit Titel gesendet. `}
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

/** Schritte als eigene offene Punkte anlegen (Auswahl + Bestätigung). */
function StepsDialog({ open, item, steps, onClose, onDone }: { open: boolean; item: OpenItemRecord; steps: Claim[]; onClose: () => void; onDone: () => void }) {
  const { run } = useRun();
  const [selected, setSelected] = useState<Set<number>>(() => new Set(steps.map((_, i) => i)));
  const count = selected.size;
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Schritte als offene Punkte anlegen?"
      description={`Jeder ausgewählte Schritt wird ein eigener offener Punkt (Thema und Projekt wie „${item.title}“).`}
      confirmLabel={count ? `${plural(count, 'Punkt', 'Punkte')} anlegen` : 'Nichts ausgewählt'}
      confirmTestId="solution-steps-confirm"
      onConfirm={async () => {
        if (!count) return;
        const out = await run(
          () => call('openItems:applySolution', { target: 'items', id: item.id, stepIndexes: [...selected].sort((a, b) => a - b), confirmed: true }),
          { success: `${plural(count, 'offener Punkt', 'offene Punkte')} angelegt.` },
        );
        if (out) {
          onDone();
          onClose();
        }
      }}
    >
      <div className="flex flex-col gap-2" data-testid="solution-steps">
        {steps.map((s, i) => (
          <CheckboxField
            key={i}
            checked={selected.has(i)}
            onCheckedChange={(v) =>
              setSelected((prev) => {
                const next = new Set(prev);
                if (v === true) next.add(i);
                else next.delete(i);
                return next;
              })
            }
            label={
              <>
                {s.text}
                {s.uncertain && (
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
