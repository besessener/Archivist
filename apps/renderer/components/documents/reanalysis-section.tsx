'use client';

import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { Notice } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { call } from '@/lib/ipc';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import type { DocRecord } from '@/lib/types';
import { ReprocessDialog } from './reprocess-dialog';

type Change = [label: string, before: string, after: string];

/** What the proposal would change; fields it leaves empty stay as they are. */
function changesOf(doc: DocRecord, proposal: NonNullable<ReturnType<typeof useProposal>['data']>): Change[] {
  const merged = (before: string[], added: string[]) => [...new Set([...before, ...added])].join(', ');
  const candidates: Change[] = [
    ['Titel', doc.title, proposal.title],
    ['Typ', doc.docType ?? '', proposal.docType ?? ''],
    ['Zusammenfassung', doc.summary ?? '', proposal.summary ?? ''],
    ['Dokumentdatum', doc.documentDate ?? '', proposal.documentDate ?? ''],
    ['Thema', doc.topicName ?? '', proposal.topic ?? ''],
    ['Projekt', doc.projectName ?? '', proposal.project ?? ''],
    ['Personen', doc.persons.join(', '), merged(doc.persons, proposal.persons)],
    ['Schlagwörter', doc.tags.join(', '), merged(doc.tags, proposal.tags)],
  ];
  return candidates.filter(([, before, after]) => after !== '' && before !== after);
}

const useProposal = (id: string) => useQuery('documents:reanalysis', { id }, { scopes: ['documents'], jobs: true });

/** New metadata proposed for an archived document: shown as before → after, applied only after the confirmation (#220). */
export function ReanalysisSection({ doc, onChanged }: { doc: DocRecord; onChanged: () => void }) {
  const proposal = useProposal(doc.id);
  const { run, busy } = useRun();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reprocessOpen, setReprocessOpen] = useState(false);
  const data = proposal.data;
  const changes = data ? changesOf(doc, data) : [];

  return (
    <section aria-labelledby="reanalysis-heading" className="flex flex-col gap-2" data-testid="reanalysis">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="reanalysis-heading" className="text-sm font-semibold">
          Neue Metadaten
        </h3>
        <Button size="sm" variant="outline" onClick={() => setReprocessOpen(true)} data-testid="doc-reprocess">
          <RefreshCw aria-hidden /> Neu analysieren …
        </Button>
      </div>
      {data && (
        <Notice title={data.analyzedBy === 'llm' ? 'Vorschlag der KI' : 'Vorschlag aus der lokalen Analyse'} data-testid="reanalysis-proposal">
          {changes.length === 0 ? (
            <p>Der Vorschlag ändert nichts an den bisherigen Angaben.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {changes.map(([label, before, after]) => (
                <li key={label} data-testid="reanalysis-change">
                  <span className="font-medium">{label}: </span>
                  <span className="text-muted-foreground line-through">{before || '–'}</span> → <span>{after}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" disabled={busy || changes.length === 0} onClick={() => setConfirmOpen(true)} data-testid="reanalysis-apply">
              Neue Angaben übernehmen …
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              data-testid="reanalysis-discard"
              onClick={async () => {
                const out = await run(() => call('documents:discardReanalysis', { id: doc.id }), { success: 'Vorschlag verworfen.' });
                if (out) {
                  void proposal.refetch();
                  onChanged();
                }
              }}
            >
              Verwerfen
            </Button>
          </div>
        </Notice>
      )}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Neue Angaben übernehmen?"
        description="Diese Angaben werden im Archiv geändert. Datei und Ablageort bleiben unverändert; du kannst die Änderung im Änderungsprotokoll rückgängig machen."
        confirmLabel="Angaben übernehmen"
        confirmTestId="reanalysis-apply-confirm"
        onConfirm={async () => {
          const out = await run(() => call('documents:applyReanalysis', { id: doc.id, confirmed: true }), {
            success: 'Neue Angaben übernommen.',
            errorTitle: 'Angaben konnten nicht übernommen werden',
          });
          setConfirmOpen(false);
          if (out) onChanged();
        }}
      >
        <ul className="flex flex-col gap-1.5 text-sm">
          {changes.map(([label, before, after]) => (
            <li key={label}>
              <span className="font-medium">{label}: </span>
              <span className="text-muted-foreground line-through">{before || '–'}</span> → <span>{after}</span>
            </li>
          ))}
        </ul>
      </ConfirmDialog>
      {reprocessOpen && (
        <ReprocessDialog
          ids={[doc.id]}
          onClose={() => setReprocessOpen(false)}
          onStarted={() => {
            setReprocessOpen(false);
            void proposal.refetch();
          }}
        />
      )}
    </section>
  );
}
