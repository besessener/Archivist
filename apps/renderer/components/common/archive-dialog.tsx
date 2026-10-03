'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ArchiveItemRequest, ArchiveMode } from '@archivist/shared';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CheckboxField } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { call, errorMessage } from '@/lib/ipc';
import { useRun } from '@/lib/use-run';
import type { ArchivePlanRecord, ArchiveResultRecord, DocRecord } from '@/lib/types';
import { ArchivePlanItem, NewCategoriesNotice } from './archive-plan';
import { ArchiveResultView } from './archive-result';
import { ErrorNote, Loading, Notice } from './states';
import { withMembership } from '@/lib/utils';

export interface ArchiveEdit {
  mode: ArchiveMode;
  categoryPath: string;
  fileName: string;
  topic: string;
  project: string;
}

export function defaultEdit(doc: DocRecord): ArchiveEdit {
  return {
    mode: doc.archiveMode ?? 'copy',
    categoryPath: doc.proposal?.location.categoryPath ?? doc.categoryPath ?? '',
    fileName: doc.proposal?.location.fileName ?? '',
    topic: doc.proposal?.topic ?? doc.topicName ?? '',
    project: doc.proposal?.project ?? doc.projectName ?? '',
  };
}

export function toArchiveItem(doc: DocRecord, edit: ArchiveEdit): ArchiveItemRequest {
  const item: ArchiveItemRequest = { documentId: doc.id, mode: edit.mode };
  if (edit.categoryPath.trim()) item.categoryPath = edit.categoryPath.trim();
  if (edit.fileName.trim()) item.fileName = edit.fileName.trim();
  // An emptied field explicitly means "without topic/project" – send null so the backend does not fall back to the proposal.
  item.topic = edit.topic.trim() || null;
  item.project = edit.project.trim() || null;
  return item;
}

export interface ArchiveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: ArchiveItemRequest[];
  /** Called after successful execution. */
  onDone?: (result: ArchiveResultRecord) => void;
}

/** Archive dialog for inbox and scan: shows the preview and runs `documents:archive` only after explicit confirmation. */
export function ArchiveDialog({ open, onOpenChange, items, onDone }: ArchiveDialogProps) {
  const [plan, setPlan] = useState<ArchivePlanRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [approvedCategories, setApprovedCategories] = useState<Set<string>>(new Set());
  const [confirmMove, setConfirmMove] = useState(false);
  const [strongAcknowledged, setStrongAcknowledged] = useState(false);
  const [result, setResult] = useState<ArchiveResultRecord | null>(null);
  const { run, busy } = useRun();
  const itemsKey = JSON.stringify(items);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const preview = await call('documents:previewArchive', { items });
      setPlan(preview);
      setIncluded(new Set(preview.items.filter((item) => !item.blocked).map((item) => item.documentId)));
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [itemsKey]);

  useEffect(() => {
    if (!open) return;
    setPlan(null);
    setResult(null);
    setApprovedCategories(new Set());
    setConfirmMove(false);
    setStrongAcknowledged(false);
    void load();
  }, [open, load]);

  const planItems = plan?.items ?? [];
  const includedItems = planItems.filter((item) => included.has(item.documentId));
  const needsMove = includedItems.some((item) => item.action === 'move');
  const categories = useMemo(() => {
    const unique = new Set<string>(plan?.newCategories ?? []);
    for (const item of includedItems) for (const category of item.newCategories) unique.add(category);
    return [...unique];
  }, [plan, includedItems]);

  const canExecute = !!plan && includedItems.length > 0 && (!needsMove || confirmMove) && (!plan.requiresStrongConfirmation || strongAcknowledged) && !busy;

  async function execute() {
    const sendItems = items.filter((item) => included.has(item.documentId));
    const archived = await run(
      () =>
        call('documents:archive', {
          items: sendItems,
          confirmed: true,
          approveNewCategories: categories.filter((category) => approvedCategories.has(category)),
          confirmMove: needsMove && confirmMove,
        }),
      { errorTitle: 'Archivieren fehlgeschlagen' },
    );
    if (!archived) return;
    setResult(archived);
    onDone?.(archived);
  }

  const titleOf = (id: string) => planItems.find((item) => item.documentId === id)?.title ?? id;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl" data-testid="archive-dialog">
        <DialogHeader>
          <DialogTitle>{result ? 'Ergebnis' : 'Archivierung prüfen'}</DialogTitle>
          <DialogDescription>
            {result ? 'So wurde deine Auswahl verarbeitet.' : 'Bitte prüfe, was passieren wird. Es wird erst etwas geändert, wenn du „Jetzt ausführen“ wählst.'}
          </DialogDescription>
        </DialogHeader>

        {loading && <Loading label="Vorschau wird erstellt …" />}
        {loadError && <ErrorNote error={loadError} onRetry={() => void load()} />}

        {plan && !result && (
          <div className="flex flex-col gap-4">
            {plan.summary && <p className="text-sm text-muted-foreground">{plan.summary}</p>}
            <ul className="flex flex-col gap-2" data-testid="archive-plan">
              {planItems.map((item) => (
                <ArchivePlanItem
                  key={item.documentId}
                  item={item}
                  included={included.has(item.documentId)}
                  onIncludedChange={(member) => setIncluded((previous) => withMembership(previous, { value: item.documentId, present: member }))}
                />
              ))}
            </ul>

            {categories.length > 0 && (
              <NewCategoriesNotice
                categories={categories}
                approved={approvedCategories}
                onApprovedChange={(category, member) => setApprovedCategories((previous) => withMembership(previous, { value: category, present: member }))}
              />
            )}

            {needsMove && (
              <Notice tone="warning" title="Verschieben entfernt die Originaldateien">
                <CheckboxField
                  checked={confirmMove}
                  onCheckedChange={(checked) => setConfirmMove(checked === true)}
                  label="Ich verstehe: Die Originaldateien werden von ihrem bisherigen Ort entfernt."
                  data-testid="archive-confirm-move"
                />
              </Notice>
            )}
            {plan.requiresStrongConfirmation && (
              <Notice tone="warning" title="Diese Archivierung ist besonders folgenreich">
                <CheckboxField
                  checked={strongAcknowledged}
                  onCheckedChange={(checked) => setStrongAcknowledged(checked === true)}
                  label="Ich habe die Vorschau vollständig geprüft."
                  data-testid="archive-strong-ack"
                />
              </Notice>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
                Abbrechen
              </Button>
              <Button disabled={!canExecute} onClick={() => void execute()} data-testid="archive-confirm">
                {busy && <Loader2 className="animate-spin" aria-hidden />}
                Jetzt ausführen ({includedItems.length})
              </Button>
            </DialogFooter>
          </div>
        )}

        {result && <ArchiveResultView result={result} titleOf={titleOf} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}
