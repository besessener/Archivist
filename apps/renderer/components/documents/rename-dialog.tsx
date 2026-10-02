'use client';

import { useState } from 'react';
import { Field, Notice } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { IpcOutput } from '@archivist/shared';
import { call } from '@/lib/ipc';
import { plural } from '@/lib/format';
import { useRun } from '@/lib/use-run';
import type { ArchiveResultRecord, DocRecord } from '@/lib/types';

const DEFAULT_PATTERN = '{datum} {typ} {absender}';
const baseName = (rel: string | null) => (rel ? rel.split('/').at(-1)! : '–');

type Preview = IpcOutput<'documents:previewRename'>;

/** Renames archived files of a multi-selection by a scheme: preview with conflicts first, then rename (#304, same function as the agent). */
export function RenameDialog({ docs, onClose, onDone }: { docs: DocRecord[]; onClose: () => void; onDone: (r: ArchiveResultRecord) => void }) {
  const [pattern, setPattern] = useState(DEFAULT_PATTERN);
  const [preview, setPreview] = useState<{ pattern: string; items: Preview } | null>(null);
  const { run, busy } = useRun();
  const ids = docs.filter((d) => d.status === 'archived').map((d) => d.id);
  const current = preview?.pattern === pattern.trim() ? preview.items : null;
  const ready = current?.filter((i) => !i.conflicts.length && !i.unchanged).length ?? 0;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="bulk-rename-dialog">
        <DialogHeader>
          <DialogTitle>{plural(ids.length, ['Datei', 'Dateien'])} umbenennen</DialogTitle>
          <DialogDescription>
            Platzhalter: {'{datum}'}, {'{jahr}'}, {'{monat}'}, {'{typ}'}, {'{absender}'}, {'{titel}'}, {'{thema}'}, {'{projekt}'}, {'{original}'}. Nichts wird
            überschrieben; jede Umbenennung lässt sich rückgängig machen.
          </DialogDescription>
        </DialogHeader>
        {ids.length < docs.length && (
          <Notice tone="warning">
            {plural(docs.length - ids.length, ['Dokument ist', 'Dokumente sind'])} nicht archiviert und {docs.length - ids.length === 1 ? 'bleibt' : 'bleiben'}{' '}
            unverändert.
          </Notice>
        )}
        <Field label="Namensschema" htmlFor="bulk-rename-pattern">
          <Input id="bulk-rename-pattern" value={pattern} onChange={(e) => setPattern(e.target.value)} data-testid="bulk-rename-pattern" />
        </Field>
        {current && (
          <ul className="flex max-h-60 flex-col gap-1 overflow-y-auto text-sm" data-testid="bulk-rename-preview" aria-label="Vorschau der neuen Namen">
            {current.map((i) => (
              <li key={i.documentId} className="break-all">
                {baseName(i.from)} → <strong>{baseName(i.to)}</strong>
                {i.unchanged && <span className="text-muted-foreground"> (unverändert)</span>}
                {i.conflicts.length > 0 && <span className="text-destructive"> – {i.conflicts.join(' ')}</span>}
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            variant="outline"
            disabled={!pattern.trim() || !ids.length || busy}
            data-testid="bulk-rename-preview-button"
            onClick={async () => {
              const out = await run(() => call('documents:previewRename', { ids, pattern: pattern.trim() }), { errorTitle: 'Vorschau fehlgeschlagen' });
              if (out) setPreview({ pattern: pattern.trim(), items: out });
            }}
          >
            Vorschau
          </Button>
          <Button
            disabled={!ready || busy}
            data-testid="bulk-rename-save"
            onClick={async () => {
              const out = await run(() => call('documents:rename', { ids, pattern: pattern.trim(), confirmed: true }), {
                errorTitle: 'Umbenennen fehlgeschlagen',
              });
              if (out) onDone(out);
            }}
          >
            {ready ? `${plural(ready, ['Datei', 'Dateien'])} umbenennen` : 'Umbenennen'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
