'use client';

import { useState } from 'react';
import { ArchiveRestore, Eye, EyeOff, FileInput, FolderOpen, RefreshCw, Shield, ShieldOff } from 'lucide-react';
import type { Settings } from '@archivist/shared';
import type { ArchiveEdit } from '@/components/common/archive-dialog';
import { IconAction } from '@/components/common/icon-action';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { call } from '@/lib/ipc';
import { useToast } from '@/lib/toast';
import { useRun } from '@/lib/use-run';
import type { DocRecord } from '@/lib/types';
import { ArchiveFields, DocFindings, DocHeader, DocNotes, DocProposal } from './doc-details';
import { ReleaseQuarantineDialog, ReprocessDialog } from './doc-dialogs';

export interface DocCardProps {
  doc: DocRecord;
  edit: ArchiveEdit;
  onEdit: (edit: ArchiveEdit) => void;
  selected: boolean;
  onSelect: (selected: boolean) => void;
  onArchive: () => void;
  onChanged: () => void;
  /** Privacy mode; in „vorher fragen“ (confirm) reprocessing with the AI needs a confirmation. */
  llmMode: Settings['privacy']['llmMode'];
  /** Configured AI endpoint (shown in the confirmation). */
  llmBaseUrl: string;
}

/** Documents that could not be processed or were held back stand out in the list. */
const STRIPES: Partial<Record<DocRecord['status'], 'danger'>> = { failed: 'danger', quarantined: 'danger' };

export function InboxDocCard({ doc, edit, onEdit, selected, onSelect, onArchive, onChanged, llmMode: mode, llmBaseUrl }: DocCardProps) {
  const { run, busy } = useRun();
  const { toast } = useToast();
  const [reprocessOpen, setReprocessOpen] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const llmPossible = mode !== 'local_only' && doc.llmStatus !== 'excluded' && doc.folderLlmAllowed;
  const quarantined = doc.status === 'quarantined';
  const ignored = doc.status === 'ignored';
  const archivable = doc.status === 'staged' || doc.status === 'proposed';

  const reprocess = async ({ allowLlm }: { allowLlm: boolean }) => {
    const started = await run(() => call('documents:classify', { documentId: doc.id, allowLlm }), {
      success: allowLlm ? 'Die Verarbeitung mit KI wurde gestartet.' : 'Die lokale Verarbeitung wurde gestartet.',
    });
    onChanged();
    return started;
  };

  const ignore = async () => {
    const out = await run(() => call('documents:ignore', { id: doc.id }));
    onChanged();
    if (!out) return;
    toast({
      title: 'Dokument ignoriert.',
      variant: 'success',
      actionLabel: 'Rückgängig',
      onAction: () => void run(() => call('audit:undo', { auditId: out.auditId }), { success: 'Ignorieren rückgängig gemacht.' }).then(onChanged),
    });
  };

  const takeBack = async () => {
    await run(() => call('documents:unignore', { id: doc.id }), { success: 'Dokument wieder aufgenommen.' });
    onChanged();
  };

  const release = async () => {
    const released = await run(() => call('documents:releaseQuarantine', { id: doc.id, confirmed: true }), {
      success: 'Die Datei wurde importiert und wird analysiert.',
      errorTitle: 'Import aus der Quarantäne fehlgeschlagen',
    });
    if (!released) return;
    setReleaseOpen(false);
    onChanged();
  };

  return (
    <li className="rounded-xl border bg-card shadow-card p-4" data-stripe={STRIPES[doc.status]} data-testid="inbox-item" data-status={doc.status}>
      <div className="flex items-start gap-3">
        <Checkbox
          checked={selected}
          disabled={!archivable}
          onCheckedChange={(checked) => onSelect(checked === true)}
          aria-label={`${doc.title} auswählen`}
          className="mt-1"
          data-testid="inbox-select"
        />
        <div className="min-w-0 flex-1">
          <DocHeader doc={doc} />
          <DocNotes doc={doc} />
          <DocFindings doc={doc} />
          {doc.proposal && <DocProposal proposal={doc.proposal} />}
          {archivable && <ArchiveFields doc={doc} edit={edit} onEdit={onEdit} />}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {archivable && (
              <Button size="sm" onClick={onArchive} data-testid="inbox-archive" disabled={busy}>
                <ArchiveRestore aria-hidden /> Archivieren …
              </Button>
            )}
            {quarantined && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  data-testid="inbox-quarantine-reveal"
                  onClick={() => void run(() => call('app:revealPath', { documentId: doc.id }), { errorTitle: 'Ordner konnte nicht geöffnet werden' })}
                >
                  <FolderOpen aria-hidden /> Ordner öffnen
                </Button>
                <Button size="sm" variant="outline" disabled={busy} data-testid="inbox-quarantine-release" onClick={() => setReleaseOpen(true)}>
                  <FileInput aria-hidden /> Trotzdem importieren …
                </Button>
              </>
            )}
            {ignored && (
              <Button size="sm" variant="outline" disabled={busy} data-testid="inbox-unignore" onClick={() => void takeBack()}>
                <Eye aria-hidden /> Wieder aufnehmen
              </Button>
            )}
            <span className="flex items-center gap-0.5">
              {doc.status !== 'analyzing' && !quarantined && !ignored && (
                <IconAction
                  label="Erneut verarbeiten"
                  disabled={busy}
                  data-testid="inbox-reprocess"
                  onClick={async () => {
                    // „vorher fragen“: every external transfer needs an explicit confirmation
                    if (llmPossible && mode === 'confirm') setReprocessOpen(true);
                    else await reprocess({ allowLlm: llmPossible });
                  }}
                >
                  <RefreshCw aria-hidden />
                </IconAction>
              )}
              {!quarantined && !ignored && (
                <IconAction
                  label={doc.llmStatus === 'excluded' ? 'Externe Analyse erlauben' : 'Von externer Analyse ausschließen'}
                  disabled={busy}
                  data-testid="inbox-exclude-llm"
                  onClick={async () => {
                    const excluded = doc.llmStatus !== 'excluded';
                    await run(() => call('documents:setLlmExcluded', { id: doc.id, excluded }), {
                      success: excluded ? 'Wird nicht mehr extern analysiert.' : 'Externe Analyse wieder erlaubt.',
                    });
                    onChanged();
                  }}
                >
                  {doc.llmStatus === 'excluded' ? <Shield aria-hidden /> : <ShieldOff aria-hidden />}
                </IconAction>
              )}
              {!ignored && (
                <IconAction label="Ignorieren" disabled={busy} data-testid="inbox-ignore" onClick={() => void ignore()}>
                  <EyeOff aria-hidden />
                </IconAction>
              )}
            </span>
          </div>
        </div>
      </div>
      <ReprocessDialog doc={doc} open={reprocessOpen} onOpenChange={setReprocessOpen} llmBaseUrl={llmBaseUrl} onReprocess={reprocess} />
      {quarantined && <ReleaseQuarantineDialog doc={doc} open={releaseOpen} onOpenChange={setReleaseOpen} onRelease={release} />}
    </li>
  );
}
