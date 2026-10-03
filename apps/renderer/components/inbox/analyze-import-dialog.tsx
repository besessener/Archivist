'use client';

import { useState } from 'react';
import { BulkConsent } from '@/components/common/bulk-consent';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { ErrorNote, Loading, Notice } from '@/components/common/states';
import { call } from '@/lib/ipc';
import { plural } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';

/** „Alle N mit KI analysieren“ after an import that was analysed locally: the same consent as for every bulk run (#228). */
export function AnalyzeImportDialog({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const estimate = useQuery('documents:analyzeImportEstimate', { jobId });
  const { run } = useRun();
  const [llmOk, setLlmOk] = useState(false);
  const data = estimate.data;

  async function start() {
    if (!llmOk) return;
    const started = await run(() => call('documents:analyzeImport', { jobId, confirmLlm: true }), {
      success: 'Analyse mit KI gestartet.',
      errorTitle: 'Analyse konnte nicht gestartet werden',
    });
    if (started) onClose();
  }

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={data ? `Alle ${plural(data.total, ['Dokument', 'Dokumente'])} mit KI analysieren` : 'Mit KI analysieren'}
      description="Die Analyse läuft in einem Auftrag im Hintergrund. Du gibst die Einwilligung nur einmal für alle."
      confirmLabel="Mit KI analysieren"
      confirmTestId="analyze-import-confirm"
      onConfirm={start}
    >
      {estimate.error && !data && <ErrorNote error={estimate.error} onRetry={() => void estimate.refetch()} />}
      {!data && !estimate.error && <Loading />}
      {data && data.total === 0 && <Notice>Alle Dokumente dieses Imports sind schon archiviert oder entfernt.</Notice>}
      {data && data.total > 0 && (
        <BulkConsent estimate={data} noun={['Dokument', 'Dokumente']} checked={llmOk} onCheckedChange={setLlmOk} testId="analyze-import-llm" />
      )}
    </ConfirmDialog>
  );
}
