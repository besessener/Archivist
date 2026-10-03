'use client';

import { useState } from 'react';
import { BulkConsent } from '@/components/common/bulk-consent';
import { ErrorNote, Loading, Notice } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { CheckboxField } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { call } from '@/lib/ipc';
import { plural } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import { useSettings } from '@/lib/use-settings';

/** „Auswahl neu verarbeiten“ (#220): one job that reads the files again, proposes new metadata and rebuilds the index entries. */
export function ReprocessDialog({ ids, onClose, onStarted }: { ids: string[]; onClose: () => void; onStarted: () => void }) {
  const estimate = useQuery('documents:reprocessEstimate', { ids });
  const { settings } = useSettings();
  const { run, busy } = useRun();
  const [reread, setReread] = useState(true);
  const [reanalyze, setReanalyze] = useState(true);
  const [llmOk, setLlmOk] = useState(false);
  const data = estimate.data;
  const mode = settings?.privacy.llmMode ?? 'confirm';
  const asksConsent = reanalyze && mode === 'confirm' && (data?.llmEligible ?? 0) > 0;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="reprocess-dialog">
        <DialogHeader>
          <DialogTitle>{plural(data?.total ?? ids.length, ['Dokument', 'Dokumente'])} neu verarbeiten</DialogTitle>
          <DialogDescription>
            Dateien und Ablageorte bleiben unverändert. Neue Angaben (Titel, Typ, Zusammenfassung, Thema …) sind nur Vorschläge, die du im Dokument prüfst und
            bestätigst – die Übernahme lässt sich im Änderungsprotokoll rückgängig machen.
          </DialogDescription>
        </DialogHeader>
        {estimate.error && !data && <ErrorNote error={estimate.error} onRetry={() => void estimate.refetch()} />}
        {!data && !estimate.error && <Loading />}
        {data && (
          <div className="flex flex-col gap-3">
            {data.total < ids.length && (
              <Notice tone="warning">{plural(ids.length - data.total, ['Dokument ist', 'Dokumente sind'])} nicht archiviert und wird übersprungen.</Notice>
            )}
            <CheckboxField
              checked={reread}
              onCheckedChange={(v) => setReread(v === true)}
              label="Datei erneut einlesen (Text und Texterkennung) und den Sucheintrag neu aufbauen"
              data-testid="reprocess-reread"
            />
            <CheckboxField
              checked={reanalyze}
              onCheckedChange={(v) => setReanalyze(v === true)}
              label="Neue Metadaten vorschlagen"
              data-testid="reprocess-reanalyze"
            />
            {asksConsent && <BulkConsent estimate={data} noun={['Dokument', 'Dokumente']} checked={llmOk} onCheckedChange={setLlmOk} testId="reprocess-llm" />}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            disabled={busy || !data || data.total === 0 || (!reread && !reanalyze)}
            data-testid="reprocess-start"
            onClick={async () => {
              const out = await run(() => call('documents:reprocess', { ids, reread, reanalyze, confirmLlm: asksConsent && llmOk }), {
                success: 'Neuverarbeitung gestartet.',
                errorTitle: 'Neuverarbeitung konnte nicht gestartet werden',
              });
              if (out) onStarted();
            }}
          >
            {asksConsent && llmOk ? 'Mit KI neu verarbeiten' : 'Neu verarbeiten'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
