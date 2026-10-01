'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ArchiveItemRequest, ArchiveMode } from '@archivist/shared';
import { AlertTriangle, ArrowRight, Loader2, Undo2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CheckboxField } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { call, errorMessage } from '@/lib/ipc';
import { ARCHIVE_MODE_SHORT } from '@/lib/labels';
import { formatPercent } from '@/lib/format';
import { useRun } from '@/lib/use-run';
import type { ArchivePlanRecord, ArchiveResultRecord, DocRecord } from '@/lib/types';
import { EntityChip } from './entity-chip';
import { ErrorNote, Loading, Notice } from './states';

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
  if (edit.topic.trim()) item.topic = edit.topic.trim();
  if (edit.project.trim()) item.project = edit.project.trim();
  return item;
}

interface UndoState {
  busy?: boolean;
  message?: string;
  conflicts?: string[];
  undone?: boolean;
}

export interface ArchiveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: ArchiveItemRequest[];
  /** Wird nach erfolgreicher Ausführung aufgerufen. */
  onDone?: (result: ArchiveResultRecord) => void;
}

/**
 * Gemeinsamer Archivier-Dialog (Inbox + Scan): zeigt zuerst die Vorschau (`documents:previewArchive`),
 * führt erst nach ausdrücklicher Bestätigung `documents:archive` mit `confirmed: true` aus.
 */
export function ArchiveDialog({ open, onOpenChange, items, onDone }: ArchiveDialogProps) {
  const [plan, setPlan] = useState<ArchivePlanRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [approvedCats, setApprovedCats] = useState<Set<string>>(new Set());
  const [confirmMove, setConfirmMove] = useState(false);
  const [strongAck, setStrongAck] = useState(false);
  const [result, setResult] = useState<ArchiveResultRecord | null>(null);
  const [undo, setUndo] = useState<Record<string, UndoState>>({});
  const { run, busy } = useRun();
  const itemsKey = JSON.stringify(items);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const p = await call('documents:previewArchive', { items });
      setPlan(p);
      setIncluded(new Set(p.items.filter((i) => !i.blocked).map((i) => i.documentId)));
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
    setUndo({});
    setApprovedCats(new Set());
    setConfirmMove(false);
    setStrongAck(false);
    void load();
  }, [open, load]);

  const planItems = plan?.items ?? [];
  const includedItems = planItems.filter((i) => included.has(i.documentId));
  const needsMove = includedItems.some((i) => i.action === 'move');
  const categories = useMemo(() => {
    const set = new Set<string>(plan?.newCategories ?? []);
    for (const i of includedItems) for (const c of i.newCategories) set.add(c);
    return [...set];
  }, [plan, includedItems]);

  const canExecute =
    !!plan && includedItems.length > 0 && (!needsMove || confirmMove) && (!plan.requiresStrongConfirmation || strongAck) && !busy;

  async function execute() {
    const sendItems = items.filter((it) => included.has(it.documentId));
    const out = await run(
      () =>
        call('documents:archive', {
          items: sendItems,
          confirmed: true,
          approveNewCategories: categories.filter((c) => approvedCats.has(c)),
          confirmMove: needsMove && confirmMove,
        }),
      { errorTitle: 'Archivieren fehlgeschlagen' },
    );
    if (out) {
      setResult(out);
      onDone?.(out);
    }
  }

  async function undoItem(documentId: string, auditId: string) {
    setUndo((u) => ({ ...u, [documentId]: { busy: true } }));
    try {
      const res = await call('documents:undoArchive', { auditId });
      setUndo((u) => ({ ...u, [documentId]: { message: res.message, conflicts: res.conflicts, undone: res.undone } }));
    } catch (err) {
      setUndo((u) => ({ ...u, [documentId]: { message: errorMessage(err), conflicts: [], undone: false } }));
    }
  }

  const titleOf = (id: string) => planItems.find((i) => i.documentId === id)?.title ?? id;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl" data-testid="archive-dialog">
        <DialogHeader>
          <DialogTitle>{result ? 'Ergebnis' : 'Archivierung prüfen'}</DialogTitle>
          <DialogDescription>
            {result
              ? 'So wurde Ihre Auswahl verarbeitet.'
              : 'Bitte prüfen Sie, was passieren wird. Es wird erst etwas geändert, wenn Sie „Jetzt ausführen“ wählen.'}
          </DialogDescription>
        </DialogHeader>

        {loading && <Loading label="Vorschau wird erstellt …" />}
        {loadError && <ErrorNote error={loadError} onRetry={() => void load()} />}

        {plan && !result && (
          <div className="flex flex-col gap-4">
            {plan.summary && <p className="text-sm text-muted-foreground">{plan.summary}</p>}
            <ul className="flex flex-col gap-2" data-testid="archive-plan">
              {planItems.map((it) => (
                <li key={it.documentId} className="rounded-lg border p-3 text-sm" data-testid="archive-plan-item">
                  <div className="flex items-start gap-2">
                    <CheckboxField
                      checked={included.has(it.documentId)}
                      disabled={it.blocked}
                      aria-label={`${it.title} einbeziehen`}
                      onCheckedChange={(v) =>
                        setIncluded((prev) => {
                          const next = new Set(prev);
                          if (v === true) next.add(it.documentId);
                          else next.delete(it.documentId);
                          return next;
                        })
                      }
                      label={<span className="font-medium">{it.title}</span>}
                      className="min-w-0 flex-1"
                    />
                    <Badge variant={it.action === 'move' ? 'warning' : 'secondary'}>{ARCHIVE_MODE_SHORT[it.action]}</Badge>
                    {it.confidence !== null && <Badge variant="outline">{formatPercent(it.confidence)}</Badge>}
                  </div>
                  {(it.sourcePath || it.targetPath) && (
                    <div className="mt-2 grid items-center gap-1 text-xs sm:grid-cols-[1fr_auto_1fr]">
                      <code className="break-all rounded bg-muted px-1.5 py-1" data-testid="archive-plan-source" title="Quelle">
                        {it.sourcePath ?? '–'}
                      </code>
                      <ArrowRight className="mx-auto size-4 rotate-90 text-muted-foreground sm:rotate-0" aria-hidden />
                      <code className="break-all rounded bg-muted px-1.5 py-1" data-testid="archive-plan-target" title="Ziel">
                        {it.targetPath ?? (it.action === 'index_only' ? 'Wird nur durchsuchbar gemacht (keine Datei wird kopiert)' : '–')}
                      </code>
                    </div>
                  )}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {it.renamed && <Badge variant="info">Wird umbenannt</Badge>}
                    {it.willRemoveSource && <Badge variant="warning">Original wird entfernt</Badge>}
                    {it.blocked && <Badge variant="danger">Blockiert</Badge>}
                  </div>
                  {it.rationale && <p className="mt-2 text-xs text-muted-foreground">{it.rationale}</p>}
                  {it.duplicates.length > 0 && (
                    <Notice tone="warning" title="Mögliche Duplikate" className="mt-2">
                      <ul className="list-disc pl-5">
                        {it.duplicates.map((d) => (
                          <li key={d.documentId}>
                            {d.title}
                            {d.archivePath ? ` – ${d.archivePath}` : ''}
                          </li>
                        ))}
                      </ul>
                    </Notice>
                  )}
                  {it.conflicts.length > 0 && (
                    <Notice tone="danger" title="Konflikte" className="mt-2" data-testid="archive-conflicts">
                      <ul className="list-disc pl-5">
                        {it.conflicts.map((c) => (
                          <li key={c}>{c}</li>
                        ))}
                      </ul>
                    </Notice>
                  )}
                  {it.affected.length > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                      <span className="text-muted-foreground">Betroffen:</span>
                      {it.affected.map((e) => (
                        <EntityChip key={`${e.type}-${e.id}`} type={e.type} id={e.id} label={e.label} detail={e.detail} />
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>

            {categories.length > 0 && (
              <Notice tone="info" title="Neue Hauptkategorien">
                <p className="mb-2">Dafür werden neue Ordner angelegt. Bitte bestätigen Sie jede Neuanlage einzeln.</p>
                <div className="flex flex-col gap-1.5">
                  {categories.map((c) => (
                    <CheckboxField
                      key={c}
                      checked={approvedCats.has(c)}
                      onCheckedChange={(v) =>
                        setApprovedCats((prev) => {
                          const next = new Set(prev);
                          if (v === true) next.add(c);
                          else next.delete(c);
                          return next;
                        })
                      }
                      label={
                        <span>
                          Neue Kategorie <strong>{c}</strong> anlegen
                        </span>
                      }
                      data-testid="archive-new-category"
                    />
                  ))}
                </div>
              </Notice>
            )}

            {needsMove && (
              <Notice tone="warning" title="Verschieben entfernt die Originaldateien">
                <CheckboxField
                  checked={confirmMove}
                  onCheckedChange={(v) => setConfirmMove(v === true)}
                  label="Ich verstehe: Die Originaldateien werden von ihrem bisherigen Ort entfernt."
                  data-testid="archive-confirm-move"
                />
              </Notice>
            )}
            {plan.requiresStrongConfirmation && (
              <Notice tone="warning" title="Diese Archivierung ist besonders folgenreich">
                <CheckboxField
                  checked={strongAck}
                  onCheckedChange={(v) => setStrongAck(v === true)}
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

        {result && (
          <div className="flex flex-col gap-3" data-testid="archive-result">
            <div className="flex flex-wrap gap-2">
              <Badge variant="success">{result.success} erfolgreich</Badge>
              <Badge variant="secondary">{result.skipped} übersprungen</Badge>
              <Badge variant={result.failed > 0 ? 'danger' : 'secondary'}>{result.failed} fehlgeschlagen</Badge>
              <Badge variant={result.conflicts > 0 ? 'warning' : 'secondary'}>{result.conflicts} Konflikte</Badge>
            </div>
            <ul className="flex flex-col gap-2">
              {result.items.map((it) => {
                const u = undo[it.documentId];
                return (
                  <li key={it.documentId} className="rounded-lg border p-3 text-sm" data-testid="archive-result-item" data-outcome={it.outcome}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{titleOf(it.documentId)}</span>
                      <Badge
                        variant={it.outcome === 'success' ? 'success' : it.outcome === 'failed' ? 'danger' : it.outcome === 'conflict' ? 'warning' : 'secondary'}
                      >
                        {{ success: 'Erfolgreich', skipped: 'Übersprungen', failed: 'Fehlgeschlagen', conflict: 'Konflikt' }[it.outcome]}
                      </Badge>
                    </div>
                    {it.targetPath && <code className="mt-1 block break-all rounded bg-muted px-1.5 py-1 text-xs">{it.targetPath}</code>}
                    {it.message && <p className="mt-1 text-xs text-muted-foreground">{it.message}</p>}
                    {it.auditId && it.outcome === 'success' && !u?.undone && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-2"
                        disabled={u?.busy}
                        data-testid="archive-undo"
                        onClick={() => void undoItem(it.documentId, it.auditId as string)}
                      >
                        {u?.busy ? <Loader2 className="animate-spin" aria-hidden /> : <Undo2 aria-hidden />} Rückgängig
                      </Button>
                    )}
                    {u?.message && (
                      <p className="mt-2 text-xs">
                        {u.undone ? 'Rückgängig gemacht: ' : <AlertTriangle className="mr-1 inline size-3.5 text-warning" aria-hidden />}
                        {u.message}
                      </p>
                    )}
                    {u?.conflicts && u.conflicts.length > 0 && (
                      <ul className="mt-1 list-disc pl-5 text-xs text-destructive" data-testid="undo-conflicts">
                        {u.conflicts.map((c) => (
                          <li key={c}>{c}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)} data-testid="archive-close">
                Schließen
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
