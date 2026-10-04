'use client';

import { useState } from 'react';
import { Layers } from 'lucide-react';
import { BulkConsent } from '@/components/common/bulk-consent';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { JobRow } from '@/components/common/jobs-list';
import { Button } from '@/components/ui/button';
import { call } from '@/lib/ipc';
import { plural } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import { useSettings } from '@/lib/use-settings';

const ANALYZE_ALL_JOB = 'scanner.analyzeAll';

/** „Alle N neuen Dateien analysieren“: one job for every new file, one consent where the privacy mode asks for it (#228). */
export function AnalyzeAll() {
  const estimate = useQuery('scanner:analyzeAllPreview', {}, { scopes: ['scanner', 'documents'], jobs: true });
  const jobs = useQuery('jobs:list', { limit: 50 }, { scopes: ['jobs'], jobs: true });
  const { settings } = useSettings();
  const { run, busy } = useRun();
  const [open, setOpen] = useState(false);
  const [llmOk, setLlmOk] = useState(false);
  const running = (jobs.data ?? []).find((job) => job.type === ANALYZE_ALL_JOB && (job.status === 'running' || job.status === 'pending'));
  const total = estimate.data?.total ?? 0;
  const mode = settings?.privacy.llmMode ?? 'confirm';
  const asksConsent = mode === 'confirm' && (estimate.data?.llmEligible ?? 0) > 0;

  async function start(confirmLlm: boolean) {
    const out = await run(() => call('scanner:analyzeAll', { confirmLlm }), {
      success: 'Analyse aller neuen Dateien gestartet.',
      errorTitle: 'Analyse konnte nicht gestartet werden',
    });
    if (out) {
      setOpen(false);
      void jobs.refetch();
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid="scan-analyze-all-area">
      {running ? (
        <ul data-testid="scan-analyze-all-progress">
          <JobRow job={running} onChanged={() => void jobs.refetch()} />
        </ul>
      ) : (
        total > 0 && (
          <div>
            <Button
              variant="outline"
              disabled={busy}
              data-testid="scan-analyze-all"
              onClick={() => {
                setLlmOk(false);
                if (asksConsent) setOpen(true);
                else void start(false);
              }}
            >
              <Layers aria-hidden /> Alle {plural(total, ['neue Datei', 'neuen Dateien'])} analysieren
            </Button>
          </div>
        )
      )}
      {estimate.data && (
        <ConfirmDialog
          open={open}
          onOpenChange={setOpen}
          title={`Alle ${plural(total, ['neue Datei', 'neuen Dateien'])} analysieren`}
          description="Die Analyse läuft in einem Auftrag im Hintergrund, in Blöcken zu 500 Dateien. Du gibst die Einwilligung nur einmal für alle."
          confirmLabel={llmOk ? 'Mit KI analysieren' : 'Nur lokal analysieren'}
          confirmTestId="scan-analyze-all-confirm"
          onConfirm={() => start(llmOk)}
        >
          <BulkConsent estimate={estimate.data} noun={['Datei', 'Dateien']} checked={llmOk} onCheckedChange={setLlmOk} testId="scan-analyze-all-llm" />
        </ConfirmDialog>
      )}
    </div>
  );
}
