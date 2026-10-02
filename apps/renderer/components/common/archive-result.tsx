'use client';

import { useState } from 'react';
import { AlertTriangle, Loader2, Undo2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { call, errorMessage } from '@/lib/ipc';
import type { ArchiveResultRecord } from '@/lib/types';
import { PathText } from '@/components/common/path-text';

type ResultItem = ArchiveResultRecord['items'][number];

interface UndoState {
  busy?: boolean;
  message?: string;
  conflicts?: string[];
  undone?: boolean;
}

const OUTCOME_LABELS: Record<ResultItem['outcome'], string> = {
  success: 'Erfolgreich',
  skipped: 'Übersprungen',
  failed: 'Fehlgeschlagen',
  conflict: 'Konflikt',
};

function outcomeVariant(outcome: ResultItem['outcome']) {
  return outcome === 'success' ? 'success' : outcome === 'failed' ? 'danger' : outcome === 'conflict' ? 'warning' : 'secondary';
}

/** What happened to each archived document, with undo per document. */
export function ArchiveResultView({ result, titleOf, onClose }: { result: ArchiveResultRecord; titleOf: (id: string) => string; onClose: () => void }) {
  const [undo, setUndo] = useState<Record<string, UndoState>>({});

  async function undoItem({ documentId, auditId }: { documentId: string; auditId: string }) {
    setUndo((states) => ({ ...states, [documentId]: { busy: true } }));
    try {
      const undone = await call('documents:undoArchive', { auditId });
      setUndo((states) => ({ ...states, [documentId]: { message: undone.message, conflicts: undone.conflicts, undone: undone.undone } }));
    } catch (err) {
      setUndo((states) => ({ ...states, [documentId]: { message: errorMessage(err), conflicts: [], undone: false } }));
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="archive-result">
      <div className="flex flex-wrap gap-2">
        <Badge variant="success">{result.success} erfolgreich</Badge>
        <Badge variant="secondary">{result.skipped} übersprungen</Badge>
        <Badge variant={result.failed > 0 ? 'danger' : 'secondary'}>{result.failed} fehlgeschlagen</Badge>
        <Badge variant={result.conflicts > 0 ? 'warning' : 'secondary'}>{result.conflicts} Konflikte</Badge>
      </div>
      <ul className="flex flex-col gap-2">
        {result.items.map((item) => (
          <ResultRow
            key={item.documentId}
            item={item}
            title={titleOf(item.documentId)}
            undo={undo[item.documentId]}
            onUndo={() => void undoItem({ documentId: item.documentId, auditId: item.auditId as string })}
          />
        ))}
      </ul>
      <DialogFooter>
        <Button onClick={onClose} data-testid="archive-close">
          Schließen
        </Button>
      </DialogFooter>
    </div>
  );
}

function ResultRow({ item, title, undo, onUndo }: { item: ResultItem; title: string; undo: UndoState | undefined; onUndo: () => void }) {
  return (
    <li className="rounded-lg border p-3 text-sm" data-testid="archive-result-item" data-outcome={item.outcome}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{title}</span>
        <Badge variant={outcomeVariant(item.outcome)}>{OUTCOME_LABELS[item.outcome]}</Badge>
      </div>
      {item.targetPath && (
        <code className="mt-1 block rounded bg-muted px-1.5 py-1 text-xs">
          <PathText path={item.targetPath} />
        </code>
      )}
      {item.message && <p className="mt-1 text-xs text-muted-foreground">{item.message}</p>}
      {item.auditId && item.outcome === 'success' && !undo?.undone && (
        <Button size="sm" variant="outline" className="mt-2" disabled={undo?.busy} data-testid="archive-undo" onClick={onUndo}>
          {undo?.busy ? <Loader2 className="animate-spin" aria-hidden /> : <Undo2 aria-hidden />} Rückgängig
        </Button>
      )}
      {undo?.message && (
        <p className="mt-2 text-xs">
          {undo.undone ? 'Rückgängig gemacht: ' : <AlertTriangle className="mr-1 inline size-3.5 text-warning" aria-hidden />}
          {undo.message}
        </p>
      )}
      {undo?.conflicts && undo.conflicts.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-xs text-destructive" data-testid="undo-conflicts">
          {undo.conflicts.map((conflict) => (
            <li key={conflict}>{conflict}</li>
          ))}
        </ul>
      )}
    </li>
  );
}
