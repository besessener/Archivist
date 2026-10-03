'use client';

import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { Button } from '@/components/ui/button';
import { call } from '@/lib/ipc';
import { useRun } from '@/lib/use-run';
import type { DocRecord } from '@/lib/types';

/** „In den Papierkorb“: deleting with a safety net, restorable until the trash is emptied. */
export function TrashDocumentButton({ doc, onTrashed }: { doc: DocRecord; onTrashed: () => void }) {
  const { run, busy } = useRun();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => setOpen(true)} data-testid="doc-trash">
        <Trash2 aria-hidden /> In den Papierkorb …
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="In den Papierkorb legen?"
        description={
          <>
            „{doc.title}“ verschwindet aus Archiv, Suche und Wissen. Deine Originaldatei bleibt, wo sie ist. Du kannst das Dokument unter Einstellungen → Archiv
            → Papierkorb wiederherstellen, bis du es unter Einstellungen → Archiv aus Archivist entfernst.
          </>
        }
        confirmLabel="In den Papierkorb legen"
        destructive
        confirmTestId="doc-trash-confirm"
        onConfirm={async () => {
          const result = await run(() => call('documents:trash', { id: doc.id, confirmed: true }), {
            success: 'Dokument in den Papierkorb gelegt',
            errorTitle: 'Dokument konnte nicht in den Papierkorb gelegt werden',
          });
          setOpen(false);
          if (result) onTrashed();
        }}
      />
    </>
  );
}
