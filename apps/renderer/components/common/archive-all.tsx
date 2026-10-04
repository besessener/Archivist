'use client';

import { useEffect, useState } from 'react';
import { Archive } from 'lucide-react';
import type { ArchiveAllPreview, ArchiveAllSource } from '@archivist/shared';
import { NewCategoriesNotice } from '@/components/common/archive-plan';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { JobRow } from '@/components/common/jobs-list';
import { ErrorNote, Loading } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { call, errorMessage } from '@/lib/ipc';
import { plural } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import { withMembership } from '@/lib/utils';

const ARCHIVE_ALL_JOB = 'archive.all';
const COPY_NOTE =
  'Archivist legt Kopien im Archiv ab. Deine Originale bleiben unverändert, und jedes Dokument lässt sich einzeln im Protokoll rückgängig machen.';

interface PreviewBodyProps {
  preview: ArchiveAllPreview;
  approved: Set<string>;
  onApprovedChange: (category: string, approved: boolean) => void;
}

function PreviewBody({ preview, approved, onApprovedChange }: PreviewBodyProps) {
  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="archive-all-preview">
      <p>{COPY_NOTE}</p>
      <div>
        <p className="font-medium">So sieht das Archiv danach aus:</p>
        <ul className="mt-1 flex max-h-56 flex-col gap-0.5 overflow-y-auto rounded-lg border p-2" data-testid="archive-all-folders">
          {preview.folders.map((folder) => (
            <li key={folder.path} className="flex justify-between gap-3">
              <code className="break-all">{folder.path}/</code>
              <span className="whitespace-nowrap text-muted-foreground">{plural(folder.count, ['Dokument', 'Dokumente'])}</span>
            </li>
          ))}
          {preview.moreFolders > 0 && <li className="text-muted-foreground">… und {plural(preview.moreFolders, ['weiterer Ordner', 'weitere Ordner'])}</li>}
        </ul>
      </div>
      {preview.newCategories.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="archive-all-new-folders">
          <NewCategoriesNotice categories={preview.newCategories} approved={approved} onApprovedChange={onApprovedChange} />
          <p className="text-muted-foreground">Dokumente, die einen nicht bestätigten Ordner brauchen, werden nicht archiviert und bleiben in der Inbox.</p>
        </div>
      )}
      {preview.blocked > 0 && (
        <p className="text-muted-foreground" data-testid="archive-all-blocked">
          {plural(preview.blocked, ['Dokument kann', 'Dokumente können'])} nicht archiviert werden (zum Beispiel, weil die Quelldatei fehlt) und{' '}
          {preview.blocked === 1 ? 'bleibt' : 'bleiben'} in der Inbox.
        </p>
      )}
    </div>
  );
}

/** „Alle N Vorschläge archivieren“: one confirmation with the count and the target structure, then one job in batches (#228). */
export function ArchiveAllButton({ source, testId }: { source: ArchiveAllSource; testId: string }) {
  const jobs = useQuery('jobs:list', { limit: 1, type: ARCHIVE_ALL_JOB, activeOnly: true }, { scopes: ['jobs'], jobs: true });
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<ArchiveAllPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const { run, busy } = useRun();
  const running = jobs.data?.[0];

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setLoadError(null);
    setApproved(new Set());
    call('documents:archiveAllPreview', { source })
      .then(setPreview)
      .catch((err: unknown) => setLoadError(errorMessage(err)));
  }, [open, source]);

  async function start() {
    if (!preview || preview.count === 0) return;
    const approveNewCategories = preview.newCategories.filter((category) => approved.has(category));
    const started = await run(() => call('documents:archiveAll', { previewId: preview.previewId, confirmed: true, approveNewCategories }), {
      success: 'Archivierung gestartet.',
      errorTitle: 'Archivierung konnte nicht gestartet werden',
    });
    if (started) {
      setOpen(false);
      void jobs.refetch();
    }
  }

  if (running)
    return (
      <ul className="w-full" data-testid="archive-all-progress">
        <JobRow job={running} onChanged={() => void jobs.refetch()} />
      </ul>
    );
  return (
    <>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => setOpen(true)} data-testid={testId}>
        <Archive aria-hidden /> Alle Vorschläge archivieren …
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={preview ? `Alle ${plural(preview.count, ['Vorschlag', 'Vorschläge'])} archivieren?` : 'Alle Vorschläge archivieren?'}
        description="Die Archivierung läuft in einem Auftrag im Hintergrund, in Blöcken zu 100 Dokumenten."
        confirmLabel={preview ? `${plural(preview.count, ['Dokument', 'Dokumente'])} archivieren` : 'Archivieren'}
        requireCheckbox="Ich habe die Vorschau vollständig geprüft."
        confirmTestId="archive-all-confirm"
        onConfirm={start}
      >
        {loadError && <ErrorNote error={loadError} />}
        {!preview && !loadError && <Loading label="Vorschau wird berechnet …" />}
        {preview && preview.count === 0 && <p className="text-sm text-muted-foreground">Es gibt nichts zu archivieren.</p>}
        {preview && preview.count > 0 && (
          <PreviewBody
            preview={preview}
            approved={approved}
            onApprovedChange={(category, member) => setApproved((previous) => withMembership(previous, { value: category, present: member }))}
          />
        )}
      </ConfirmDialog>
    </>
  );
}
