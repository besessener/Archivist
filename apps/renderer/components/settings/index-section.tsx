'use client';

import { useState } from 'react';
import { DatabaseZap } from 'lucide-react';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { ErrorNote, Loading } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { call } from '@/lib/ipc';
import { formatNumber } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import { Section } from './shared';

/** The search index of the archive: finds documents missing from it, adds them, and re-embeds everything on request (#220). */
export function IndexSection() {
  const status = useQuery('documents:indexStatus', {}, { scopes: ['documents'], jobs: true });
  const { run, busy } = useRun();
  const [confirmReembed, setConfirmReembed] = useState(false);
  const data = status.data;

  return (
    <Section
      title="Suchindex"
      description="Archivierte Dokumente sind über den Suchindex auffindbar. Fehlt ein Eintrag (z. B. nach einem Absturz), ergänzt Archivist ihn hier."
    >
      {status.error && !data && <ErrorNote error={status.error} onRetry={() => void status.refetch()} />}
      {!data && status.loading && <Loading />}
      {data && (
        <p className="text-sm" data-testid="index-status">
          {data.missing === 0
            ? `Alle ${formatNumber(data.documents)} archivierten Dokumente sind im Suchindex.`
            : `${formatNumber(data.missing)} von ${formatNumber(data.documents)} archivierten Dokumenten fehlen im Suchindex.`}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={busy || !data || data.missing === 0}
          data-testid="index-rebuild"
          onClick={async () => {
            const out = await run(() => call('documents:rebuildIndex', {}), { success: 'Fehlende Einträge werden ergänzt.' });
            if (out) void status.refetch();
          }}
        >
          <DatabaseZap aria-hidden /> Fehlende Einträge ergänzen
        </Button>
        <Button variant="outline" disabled={busy} data-testid="index-reembed" onClick={() => setConfirmReembed(true)}>
          Alle Einträge neu einbetten …
        </Button>
      </div>
      <ConfirmDialog
        open={confirmReembed}
        onOpenChange={setConfirmReembed}
        title="Alle Einträge neu einbetten?"
        description="Archivist berechnet die Suchvektoren für Einträge neu, die noch zu einem anderen Embedding-Modell gehören. Das läuft im Hintergrund; im Datenschutzmodus „automatisch“ gehen dafür Texte freigegebener Einträge an den eingerichteten Dienst."
        confirmLabel="Neu einbetten"
        confirmTestId="index-reembed-confirm"
        onConfirm={async () => {
          const out = await run(() => call('documents:reembed', {}), { success: 'Neu einbetten gestartet.' });
          if (out) setConfirmReembed(false);
        }}
      />
    </Section>
  );
}
