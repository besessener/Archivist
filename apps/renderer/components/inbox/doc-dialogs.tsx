'use client';

import { useState } from 'react';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { Notice } from '@/components/common/states';
import { CheckboxField } from '@/components/ui/checkbox';
import type { DocRecord } from '@/lib/types';

/** Reprocessing in „vorher fragen“ mode: local by default, the AI only with the explicit consent below. */
export function ReprocessDialog({
  doc,
  open,
  onOpenChange,
  llmBaseUrl,
  onReprocess,
}: {
  doc: DocRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  llmBaseUrl: string;
  onReprocess: (options: { allowLlm: boolean }) => Promise<unknown>;
}) {
  const [llmAllowed, setLlmAllowed] = useState(false);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(isOpen) => {
        onOpenChange(isOpen);
        if (!isOpen) setLlmAllowed(false);
      }}
      title={`„${doc.title}“ erneut verarbeiten`}
      confirmLabel={llmAllowed ? 'Mit KI analysieren' : 'Nur lokal analysieren'}
      confirmTestId="inbox-reprocess-confirm"
      onConfirm={async () => {
        if (!(await onReprocess({ allowLlm: llmAllowed }))) return;
        onOpenChange(false);
        setLlmAllowed(false);
      }}
    >
      <div className="flex flex-col gap-3 text-sm">
        <p>
          <strong>Lokal</strong> liest Archivist den Text nur auf diesem Computer. Dabei verlässt nichts deinen Rechner.
        </p>
        <Notice tone="warning" title="Was bei einer KI-Analyse gesendet wird" data-testid="inbox-reprocess-explain">
          <p>
            Der extrahierte <strong>Textinhalt</strong> dieser Datei (gekürzt, erkannte Passwörter und Schlüssel werden maskiert) sowie Dateiname und Typ werden
            an den eingerichteten KI-Dienst
            {llmBaseUrl ? (
              <>
                {' '}
                (<code className="break-all">{llmBaseUrl}</code>)
              </>
            ) : (
              ''
            )}{' '}
            gesendet. Die Originaldatei selbst wird nicht hochgeladen.
          </p>
        </Notice>
        <CheckboxField
          checked={llmAllowed}
          onCheckedChange={(checked) => setLlmAllowed(checked === true)}
          label="Ja, ich erlaube, dass der Textinhalt dieser Datei an den KI-Dienst gesendet wird."
          data-testid="inbox-reprocess-llm"
        />
      </div>
    </ConfirmDialog>
  );
}

export function ReleaseQuarantineDialog({
  doc,
  open,
  onOpenChange,
  onRelease,
}: {
  doc: DocRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRelease: () => Promise<void>;
}) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Datei trotzdem importieren?"
      description="Der Inhalt dieser Datei passt nicht zu ihrer Endung. Importiere sie nur, wenn du der Datei vertraust. Archivist liest und analysiert sie danach wie jede andere Datei."
      confirmLabel="Trotzdem importieren"
      destructive
      requireCheckbox="Ich habe die Datei geprüft und vertraue ihr."
      confirmTestId="inbox-quarantine-release-confirm"
      onConfirm={onRelease}
    >
      <p className="break-all rounded-md border bg-muted/50 p-3 text-xs">
        <span className="font-medium">{doc.originalName}</span>
        {doc.processingError ? ` – ${doc.processingError}` : ''}
      </p>
    </ConfirmDialog>
  );
}
