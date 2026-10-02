'use client';

import { FolderX, Trash2 } from 'lucide-react';
import { ErrorNote, Loading } from '@/components/common/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { call } from '@/lib/ipc';
import { formatDate } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';

export function ScanExclusions() {
  const { data, loading, error, refetch } = useQuery('scanner:listExclusions', {}, { scopes: ['scanner'] });
  const { run, busy } = useRun();

  async function addDir() {
    const selection = await run(() => call('app:selectDirectory', { title: 'Ordner ausschließen' }));
    if (!selection?.path) return;
    await run(() => call('scanner:exclude', { kind: 'dir', path: selection.path as string }), { success: 'Ordner ausgeschlossen.' });
    void refetch();
  }

  return (
    <section aria-labelledby="scan-exclusions" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="scan-exclusions" className="text-base font-semibold">
          Ausschlüsse
        </h2>
        <Button variant="outline" size="sm" onClick={() => void addDir()} disabled={busy} data-testid="scan-exclude-dir">
          <FolderX aria-hidden /> Ordner ausschließen
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">Diese Dateien und Ordner werden bei der Suche nie angezeigt.</p>
      {error && !data && <ErrorNote error={error} onRetry={() => void refetch()} />}
      {!data && loading && <Loading />}
      {data && data.length === 0 && <p className="text-sm text-muted-foreground">Keine Ausschlüsse.</p>}
      <ul className="flex flex-col gap-1.5" data-testid="scan-exclusion-list">
        {(data ?? []).map((x) => (
          <li key={x.id} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm" data-testid="scan-exclusion">
            <Badge variant="secondary">{x.kind === 'dir' ? 'Ordner' : 'Datei'}</Badge>
            <code className="min-w-0 flex-1 break-all text-xs">{x.path}</code>
            <span className="hidden text-xs text-muted-foreground sm:inline">{formatDate(x.createdAt)}</span>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Ausschluss ${x.path} entfernen`}
              onClick={async () => {
                await run(() => call('scanner:removeExclusion', { id: x.id }), { success: 'Ausschluss entfernt.' });
                void refetch();
              }}
            >
              <Trash2 aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
