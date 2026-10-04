'use client';

import { useState } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import type { IpcOutput, TrashEntry } from '@archivist/shared';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { PathText } from '@/components/common/path-text';
import { ErrorNote, Loading, Notice } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { call } from '@/lib/ipc';
import { formatDateTime } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import { Section } from './shared';

type UndoResult = IpcOutput<'audit:undo'>;

/** Documents in the trash: restore each, or empty the trash for good after a second confirmation. */
export function TrashSection() {
  const { run, busy } = useRun();
  const trash = useQuery('trash:list', {}, { scopes: ['documents', 'audit'] });
  const [results, setResults] = useState<Record<string, UndoResult>>({});
  const [emptying, setEmptying] = useState(false);
  const [compactionFailed, setCompactionFailed] = useState(false);
  const entries = trash.data ?? [];

  async function restore(entry: TrashEntry) {
    const result = await run(() => call('audit:undo', { auditId: entry.auditId }));
    if (!result) return;
    setResults((previous) => ({ ...previous, [entry.auditId]: result }));
    void trash.refetch();
  }

  return (
    <Section
      title="Papierkorb"
      description="Gelöschte Dokumente liegen hier, bis du sie aus Archivist entfernst. Bis dahin kannst du sie mit allen Verknüpfungen wiederherstellen."
    >
      {trash.error && !trash.data && <ErrorNote error={trash.error} onRetry={() => void trash.refetch()} />}
      {!trash.data && trash.loading && <Loading />}
      {trash.data && entries.length === 0 && <p className="text-sm text-muted-foreground">Der Papierkorb ist leer.</p>}
      {entries.length > 0 && (
        <ul className="flex flex-col gap-2" data-testid="trash-list">
          {entries.map((entry) => (
            <li key={entry.auditId} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border p-3" data-testid="trash-item">
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-medium">{entry.title || 'Ohne Titel'}</p>
                <p className="text-xs text-muted-foreground">Gelöscht am {formatDateTime(entry.trashedAt)}</p>
                {entry.files.map((file) => (
                  <code key={file} className="mt-1 block text-xs text-muted-foreground">
                    <PathText path={file} />
                  </code>
                ))}
                {results[entry.auditId] && !results[entry.auditId]!.undone && (
                  <Notice tone="warning" className="mt-2" title="Nicht wiederhergestellt">
                    {results[entry.auditId]!.conflicts.join(' ')}
                  </Notice>
                )}
              </div>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void restore(entry)} data-testid="trash-restore">
                <RotateCcw aria-hidden /> Wiederherstellen
              </Button>
            </li>
          ))}
        </ul>
      )}
      {compactionFailed && (
        <Notice tone="warning" title="Datenbank nicht vollständig bereinigt" data-testid="trash-compaction-warning">
          Die Dokumente sind entfernt, aber die Datenbank konnte nicht vollständig bereinigt werden. Reste des Textes können im Suchindex oder im
          Schreibprotokoll der Datenbank bleiben, bis du den Papierkorb erneut leerst; das Schreibprotokoll leert sich spätestens, wenn du Archivist beendest.
        </Notice>
      )}
      <div>
        <Button variant="outline" disabled={busy || entries.length === 0} onClick={() => setEmptying(true)} data-testid="trash-empty">
          <Trash2 aria-hidden /> Aus Archivist entfernen …
        </Button>
      </div>
      <ConfirmDialog
        open={emptying}
        onOpenChange={setEmptying}
        title="Papierkorb leeren und aus Archivist entfernen?"
        description={
          <>
            {entries.length === 1 ? 'Ein Dokument wird' : `${entries.length} Dokumente werden`} endgültig aus Archivist entfernt: die Dateien im Papierkorb, der
            gespeicherte Text samt Zusammenfassung und die Vorschauen im Übertragungsprotokoll. Das lässt sich nicht rückgängig machen. Entscheidungen, offene
            Punkte und Notizen, die aus den Dokumenten entstanden sind, bleiben erhalten. Deine Originale außerhalb von Archivist bleiben unberührt. Ältere
            Backups enthalten den Text weiterhin.
          </>
        }
        requireCheckbox="Ich verstehe, dass diese Dokumente nicht wiederhergestellt werden können und ältere Backups den Text weiterhin enthalten."
        confirmLabel="Endgültig entfernen"
        destructive
        confirmTestId="trash-empty-confirm"
        onConfirm={async (checked) => {
          if (!checked) return;
          const result = await run(() => call('trash:empty', { confirmed: true, permanentlyConfirmed: true }), {
            success: 'Aus Archivist entfernt',
          });
          if (!result) return;
          setCompactionFailed(result.documents > 0 && !result.databaseCompacted);
          setEmptying(false);
        }}
      />
    </Section>
  );
}
