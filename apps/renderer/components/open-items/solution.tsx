'use client';

import { useRef, useState } from 'react';
import { Loader2, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { call } from '@/lib/ipc';
import { useToast } from '@/lib/toast';
import type { OpenItemRecord } from '@/lib/types';
import { useRun } from '@/lib/use-run';
import { PreviewDialog, StepsDialog, type Preview } from './solution-dialogs';
import { SolutionPanel } from './solution-panel';

export interface SolutionSectionProps {
  item: OpenItemRecord;
  mode: 'auto' | 'confirm' | 'local_only';
  llmConfigured: boolean;
  onChanged: () => void;
}

/** „Lösungsvorschlag generieren“ for an active open item, with privacy prompt and cancelling, plus the saved proposal. */
export function SolutionSection({ item, mode, llmConfigured, onChanged }: SolutionSectionProps) {
  const { toast, reportError } = useToast();
  const { run, busy } = useRun();
  const [generating, setGenerating] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [stepsOpen, setStepsOpen] = useState(false);
  /** Counter per generation: results of cancelled runs are ignored. */
  const runId = useRef(0);
  const hintId = `solution-hint-${item.id}`;

  const blocked =
    mode === 'local_only'
      ? 'Im Datenschutzmodus „nur lokal“ werden keine Inhalte an die KI gesendet – Lösungsvorschläge sind deshalb deaktiviert.'
      : !llmConfigured
        ? 'Die KI ist nicht konfiguriert. Hinterlege Base URL, Modell und API-Key in den Einstellungen.'
        : null;

  async function generate({ confirmed }: { confirmed: boolean }) {
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
      void generate({ confirmed: false });
      return;
    }
    const loaded = await run(() => call('openItems:solutionPreview', { id: item.id }));
    if (loaded) setPreview(loaded);
  }

  async function cancel() {
    runId.current += 1;
    setGenerating(false);
    try {
      await call('openItems:cancelSolution', { id: item.id });
    } catch {
      /* the result is discarded anyway */
    }
    toast({ variant: 'info', title: 'Erzeugung abgebrochen – es wurde nichts geändert.' });
  }

  async function apply(target: 'description' | 'note') {
    const applied = await run(() => call('openItems:applySolution', { target, id: item.id }), {
      success: target === 'description' ? 'Vorschlag zur Beschreibung hinzugefügt.' : 'Vorschlag als Notiz gespeichert.',
    });
    if (applied) onChanged();
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
          void generate({ confirmed: true });
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
