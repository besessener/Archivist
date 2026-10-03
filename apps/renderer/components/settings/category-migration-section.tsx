'use client';

import { useState } from 'react';
import type { IpcOutput } from '@archivist/shared';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { Notice } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { call } from '@/lib/ipc';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import { Section } from './shared';

type Result = IpcOutput<'categories:migrate'>;

function NotMovedList({ items }: { items: Result['notMoved'] }) {
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

/** Offered only while English main categories (`work`, `private`) exist: renames them to the German ones after a preview and a confirmation (#233). */
export function CategoryMigrationSection() {
  const { run, busy } = useRun();
  const plan = useQuery('categories:previewMigration', {}, { scopes: ['documents', 'knowledge', 'settings'] });
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const current = plan.data;
  if (!current || (current.renames.length === 0 && !result)) return null;

  async function migrate() {
    const done = await run(() => call('categories:migrate', { confirmed: true }));
    if (!done) return;
    setConfirming(false);
    setResult(done);
    void plan.refetch();
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
            <Button variant="outline" disabled={busy} onClick={() => setConfirming(true)} data-testid="category-migration-start">
              Hauptkategorien umbenennen …
            </Button>
          </div>
        </div>
      )}
      {result && (
        <Notice tone={result.failed > 0 || result.notMoved.length > 0 ? 'warning' : 'info'} data-testid="category-migration-result">
          {result.moved} Datei(en) verschoben, {result.categoryEntriesRenamed} Kategorie-Einträge umbenannt
          {result.failed > 0 ? `, ${result.failed} Verschiebung(en) sind fehlgeschlagen` : ''}
          {result.notMoved.length > 0 ? `, ${result.notMoved.length} Datei(en) bleiben wegen eines Konflikts` : ''}. Du kannst das im Änderungsprotokoll
          rückgängig machen.
        </Notice>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Hauptkategorien umbenennen?"
        description="Archivist benennt die englischen Hauptkategorien um und verschiebt die Dateien in die neuen Ordner. Deine Originale bleiben unberührt; es wird nichts überschrieben. Dateien, deren Name im Zielordner schon vergeben ist, bleiben, wo sie sind."
        confirmLabel="Umbenennen"
        confirmTestId="category-migration-confirm"
        onConfirm={migrate}
      />
    </Section>
  );
}
