'use client';

import { useState } from 'react';
import type { IpcOutput } from '@archivist/shared';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { JobRow } from '@/components/common/jobs-list';
import { Button } from '@/components/ui/button';
import { call } from '@/lib/ipc';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import { Section } from './shared';

type NotMoved = IpcOutput<'categories:previewMigration'>['notMoved'];

const MIGRATION_JOB = 'categories.migrate';

function NotMovedList({ items }: { items: NotMoved }) {
  if (items.length === 0) return null;
  return (
    <div className="text-sm">
      <p className="font-medium">Diese Dateien bleiben, wo sie sind ({items.length})</p>
      <ul className="list-disc pl-5 text-xs text-muted-foreground" data-testid="category-migration-not-moved">
        {items.map((item) => (
          <li key={item.documentId}>
            {item.title}: {item.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Offered only while English main categories (`work`, `private`) exist: renames them after a preview and two confirmations, as a cancellable job (#233). */
export function CategoryMigrationSection() {
  const { run, busy } = useRun();
  const plan = useQuery('categories:previewMigration', {}, { scopes: ['documents', 'knowledge', 'settings'], jobs: true });
  const jobs = useQuery('jobs:list', { limit: 1, type: MIGRATION_JOB }, { scopes: ['jobs'], jobs: true });
  const [confirming, setConfirming] = useState(false);
  const [startedJobId, setStartedJobId] = useState('');
  const current = plan.data;
  const latest = jobs.data?.[0];
  const running = latest?.status === 'pending' || latest?.status === 'running';
  const job = latest && (running || latest.id === startedJobId) ? latest : undefined;
  if (!current || (current.renames.length === 0 && !job)) return null;

  async function migrate(checked: boolean) {
    if (!checked) return;
    const started = await run(() => call('categories:migrate', { confirmed: true, strongConfirmed: true }), {
      success: 'Das Umbenennen läuft im Hintergrund.',
      errorTitle: 'Das Umbenennen konnte nicht gestartet werden',
    });
    if (!started) return;
    setConfirming(false);
    setStartedJobId(started.jobId);
    void jobs.refetch();
  }

  return (
    <Section
      title="Hauptkategorien auf Deutsch umstellen"
      description="Dein Archiv enthält noch englische Hauptkategorien aus einer früheren Version. Sie lassen sich einmalig in „Arbeit“ und „Privat“ umbenennen; die Dateien werden dabei in die neuen Ordner verschoben."
    >
      {current.renames.length > 0 && (
        <div className="flex flex-col gap-2 text-sm" data-testid="category-migration-plan">
          <ul className="list-disc pl-5">
            {current.renames.map((rename) => (
              <li key={rename.from}>
                <code>{rename.from}</code> → <code>{rename.to}</code>
              </li>
            ))}
          </ul>
          <p>
            {current.documentsToMove} Datei(en) werden verschoben, {current.categoryEntries} Kategorie-Einträge umbenannt. Nichts wird überschrieben, jede
            Verschiebung steht im Änderungsprotokoll und lässt sich rückgängig machen.
          </p>
          {current.withoutFile > 0 && (
            <p className="text-muted-foreground">{current.withoutFile} Dokument(e) ohne Archivdatei behalten ihren bisherigen Pfad.</p>
          )}
          <NotMovedList items={current.notMoved} />
          <div>
            <Button variant="outline" disabled={busy || running} onClick={() => setConfirming(true)} data-testid="category-migration-start">
              Hauptkategorien umbenennen …
            </Button>
          </div>
        </div>
      )}
      {job && (
        <ul data-testid="category-migration-job">
          <JobRow job={job} onChanged={() => void jobs.refetch()} />
        </ul>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Hauptkategorien umbenennen?"
        description="Das verschiebt fast dein ganzes Archiv: Archivist benennt die englischen Hauptkategorien um und verschiebt die Dateien Datei für Datei in die neuen Ordner. Deine Originale bleiben unberührt; es wird nichts überschrieben. Dateien, deren Name im Zielordner schon vergeben ist, bleiben, wo sie sind. Du kannst den Auftrag jederzeit abbrechen: Bereits verschobene Dateien bleiben verschoben und lassen sich rückgängig machen, ein neuer Start verschiebt den Rest."
        requireCheckbox="Ich verstehe, dass dabei fast alle Dateien im Archiv in neue Ordner verschoben werden."
        confirmLabel="Umbenennen"
        confirmTestId="category-migration-confirm"
        onConfirm={migrate}
      />
    </Section>
  );
}
