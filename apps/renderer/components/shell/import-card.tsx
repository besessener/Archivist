'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { CheckCircle2, CopyX, FileWarning, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress, ProgressIndeterminate } from '@/components/ui/progress';
import { useApp } from '@/lib/app-context';
import { useQuery } from '@/lib/use-query';
import { basename } from '@/lib/utils';

const STATUS_TEXT: Record<string, string> = {
  staged: 'Wartet auf Analyse',
  analyzing: 'Wird analysiert …',
  proposed: 'Vorschlag liegt in der Inbox',
  failed: 'Fehlgeschlagen',
  quarantined: 'In Quarantäne',
  archived: 'Archiviert',
  indexed_only: 'Indexiert',
  ignored: 'Ignoriert',
};

/** Imported files whose status the card follows (one list request); the rest is only counted (#222). */
const TRACKED = 1000;

/** Progress and result of the last file import (drag and drop or file picker). */
export function ImportCard() {
  const { importState, dismissImport, importing } = useApp();
  const pathname = usePathname();
  // On the inbox page the notice is redundant and would cover controls.
  useEffect(() => {
    if (importState && pathname.startsWith('/inbox')) dismissImport();
  }, [importState, pathname, dismissImport]);
  const importedIds = importState?.result.imported.slice(0, TRACKED).map((d) => d.id) ?? [];
  const { data: docs } = useQuery(
    'documents:list',
    { ids: importedIds, limit: TRACKED },
    { scopes: ['documents'], jobs: true, enabled: importedIds.length > 0 },
  );
  if (!importState && !importing) return null;
  if (!importState) {
    return (
      <div className="absolute bottom-4 left-4 z-30 w-80 rounded-xl border bg-card p-4 shadow-lg" role="status">
        <p className="text-sm font-medium">Dateien werden übernommen …</p>
        <ProgressIndeterminate className="mt-2" />
      </div>
    );
  }
  const { imported, duplicates, rejected } = importState.result;
  const byId = new Map((docs ?? []).map((d) => [d.id, d]));
  // only the followed files: a status from the import result would stay „Wartet auf Analyse“ forever
  const current = imported.slice(0, TRACKED).map((d) => byId.get(d.id) ?? d);
  const pending = current.filter((d) => d.status === 'analyzing' || (d.status === 'staged' && d.processingStatus === 'pending')).length;
  const done = current.length - pending;
  const pct = current.length === 0 ? 100 : Math.round((done / current.length) * 100);

  return (
    <div
      className="absolute bottom-4 left-4 z-30 flex max-h-[70%] w-96 max-w-[calc(100%-2rem)] flex-col rounded-xl border bg-card shadow-lg"
      data-testid="import-card"
      role="status"
    >
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <p className="text-sm font-semibold">Import</p>
        <Button variant="ghost" size="icon-sm" aria-label="Import-Hinweis schließen" onClick={dismissImport}>
          <X aria-hidden />
        </Button>
      </div>
      <div className="flex flex-col gap-3 overflow-y-auto p-4 text-sm">
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="success">{imported.length} übernommen</Badge>
          {duplicates.length > 0 && <Badge variant="warning">{duplicates.length} bereits vorhanden</Badge>}
          {rejected.length > 0 && <Badge variant="danger">{rejected.length} abgelehnt</Badge>}
        </div>
        {imported.length > 0 && (
          <div>
            <Progress value={pct} aria-label="Verarbeitungsfortschritt" />
            <p className="mt-1 text-xs text-muted-foreground">
              {pending > 0
                ? `${done} von ${current.length} verarbeitet …`
                : `${current.length === imported.length ? 'Alle' : 'Diese'} Dateien sind verarbeitet.`}
            </p>
            {imported.length > current.length && (
              <p className="mt-1 text-xs text-muted-foreground" data-testid="import-tracked">
                Fortschritt der ersten {current.length.toLocaleString('de-DE')} von {imported.length.toLocaleString('de-DE')} Dateien; den Stand der übrigen
                zeigt die Inbox.
              </p>
            )}
            <ul className="mt-2 flex flex-col gap-1">
              {current.map((d) => (
                <li key={d.id} className="flex items-start gap-2 text-xs">
                  <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
                  <span className="min-w-0 flex-1 truncate" title={d.originalName}>
                    {d.originalName}
                  </span>
                  <span className="shrink-0 text-muted-foreground">{STATUS_TEXT[d.status] ?? d.status}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {duplicates.length > 0 && (
          <div>
            <p className="mb-1 flex items-center gap-1.5 font-medium">
              <CopyX className="size-4 text-warning" aria-hidden /> Bereits vorhanden
            </p>
            <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground" data-testid="import-duplicates">
              {duplicates.map((d) => (
                <li key={d.path} className="truncate" title={d.path}>
                  {basename(d.path)}
                </li>
              ))}
            </ul>
          </div>
        )}
        {rejected.length > 0 && (
          <div>
            <p className="mb-1 flex items-center gap-1.5 font-medium">
              <FileWarning className="size-4 text-destructive" aria-hidden /> Nicht übernommen
            </p>
            <ul className="flex flex-col gap-1 text-xs" data-testid="import-rejected">
              {rejected.map((r) => (
                <li key={r.path}>
                  <span className="font-medium">{basename(r.path)}</span>
                  <span className="block text-muted-foreground">{r.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {imported.length > 0 && (
          <Button asChild size="sm" data-testid="import-to-inbox">
            <Link href="/inbox/">Zur Inbox</Link>
          </Button>
        )}
      </div>
    </div>
  );
}
