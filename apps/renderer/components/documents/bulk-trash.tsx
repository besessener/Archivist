'use client';

import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { Button } from '@/components/ui/button';
import { call } from '@/lib/ipc';
import { plural } from '@/lib/format';
import { useRun } from '@/lib/use-run';
import type { DocRecord } from '@/lib/types';

/** „In den Papierkorb“ for the selection: one undoable trash action per document. */
export function BulkTrashButton({ docs, onDone }: { docs: DocRecord[]; onDone: (trashed: number) => void }) {
  const { run, busy } = useRun();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => setOpen(true)} data-testid="bulk-trash">
        <Trash2 aria-hidden /> In den Papierkorb …
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`${plural(docs.length, ['Dokument', 'Dokumente'])} in den Papierkorb legen?`}
        description="Die Dokumente verschwinden aus Archiv, Suche und Wissen. Deine Originaldateien bleiben, wo sie sind. Du kannst sie unter Einstellungen → Archiv → Papierkorb wiederherstellen, bis du sie dort aus Archivist entfernst."
        confirmLabel="In den Papierkorb legen"
        destructive
        confirmTestId="bulk-trash-confirm"
        onConfirm={async () => {
          let trashed = 0;
          await run(
            async () => {
              for (const doc of docs) {
                await call('documents:trash', { id: doc.id, confirmed: true });
                trashed += 1;
              }
            },
            { errorTitle: 'Nicht alle Dokumente konnten in den Papierkorb gelegt werden' },
          );
          setOpen(false);
          if (trashed > 0) onDone(trashed);
        }}
      />
    </>
  );
}
