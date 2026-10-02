'use client';

import { useState } from 'react';
import { FolderPlus, Save, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState, ErrorNote, Field, Loading } from '@/components/common/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { call } from '@/lib/ipc';
import { formatDateTime } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import type { ScanRootRecord } from '@/lib/types';
import { parseList } from '@/lib/utils';

function DirectoryCard({ root, onChanged, onRemove }: { root: ScanRootRecord; onChanged: () => void; onRemove: () => void }) {
  const { run, busy } = useRun();
  const [enabled, setEnabled] = useState(root.enabled);
  const [recursive, setRecursive] = useState(root.recursive);
  const [llmAllowed, setLlmAllowed] = useState(root.llmAllowed);
  const [excluded, setExcluded] = useState(root.excludedSubdirs.join('\n'));
  const [extensions, setExtensions] = useState(root.extensions.join(', '));
  const [maxMb, setMaxMb] = useState(String(root.maxFileSizeMb));

  async function save() {
    const mb = Number(maxMb.replace(',', '.'));
    await run(
      () =>
        call('scanner:updateDirectory', {
          id: root.id,
          enabled,
          recursive,
          llmAllowed,
          excludedSubdirs: excluded
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
          extensions: parseList(extensions).map((e) => e.replace(/^\./, '').toLowerCase()),
          ...(Number.isFinite(mb) && mb >= 0.1 ? { maxFileSizeMb: mb } : {}),
        }),
      { success: 'Verzeichnis gespeichert.' },
    );
    onChanged();
  }

  const row = (label: string, hint: string, checked: boolean, set: (v: boolean) => void, testId: string) => (
    <div className="flex items-center justify-between gap-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={set} aria-label={label} data-testid={testId} />
    </div>
  );

  return (
    <Card data-testid="scan-dir">
      <CardContent className="flex flex-col gap-4 pt-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <code className="break-all text-sm font-medium">{root.path}</code>
            <p className="mt-0.5 text-xs text-muted-foreground">Zuletzt durchsucht: {root.lastScanAt ? formatDateTime(root.lastScanAt) : 'noch nie'}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onRemove} data-testid="scan-dir-remove">
            <Trash2 aria-hidden /> Entfernen
          </Button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {row('Verzeichnis aktiv', 'Nur aktive Verzeichnisse werden durchsucht.', enabled, setEnabled, 'scan-dir-enabled')}
          {row('Unterordner einbeziehen', 'Auch alle Ordner darin durchsuchen.', recursive, setRecursive, 'scan-dir-recursive')}
          {row(
            'KI-Analyse erlaubt',
            'Inhalte aus diesem Verzeichnis dürfen (nach Bestätigung) an die KI gesendet werden.',
            llmAllowed,
            setLlmAllowed,
            'scan-dir-llm',
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Ausgeschlossene Unterordner" htmlFor={`ex-${root.id}`} hint="Ein Pfad pro Zeile.">
            <Textarea id={`ex-${root.id}`} value={excluded} onChange={(e) => setExcluded(e.target.value)} rows={3} />
          </Field>
          <div className="flex flex-col gap-3">
            <Field label="Dateitypen" htmlFor={`ext-${root.id}`} hint="Mit Komma trennen, z. B. pdf, docx, txt.">
              <Input id={`ext-${root.id}`} value={extensions} onChange={(e) => setExtensions(e.target.value)} />
            </Field>
            <Field label="Maximale Dateigröße (MB)" htmlFor={`mb-${root.id}`}>
              <Input id={`mb-${root.id}`} inputMode="decimal" value={maxMb} onChange={(e) => setMaxMb(e.target.value)} />
            </Field>
          </div>
        </div>
        <div>
          <Button size="sm" onClick={() => void save()} disabled={busy} data-testid="scan-dir-save">
            <Save aria-hidden /> Speichern
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function ScanDirectories() {
  const { data, loading, error, refetch } = useQuery('scanner:listDirectories', {}, { scopes: ['scanner'] });
  const { run, busy } = useRun();
  const [removing, setRemoving] = useState<ScanRootRecord | null>(null);

  async function add() {
    const selection = await run(() => call('app:selectDirectory', { title: 'Verzeichnis für die Dokumentensuche wählen' }));
    if (!selection?.path) return;
    await run(() => call('scanner:addDirectory', { path: selection.path as string, recursive: true }), { success: 'Verzeichnis hinzugefügt.' });
    void refetch();
  }

  return (
    <section aria-labelledby="scan-dirs" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="scan-dirs" className="text-base font-semibold">
          Verzeichnisse <Badge variant="secondary">{data?.length ?? 0}</Badge>
        </h2>
        <Button variant="outline" onClick={() => void add()} disabled={busy} data-testid="scan-add-dir">
          <FolderPlus aria-hidden /> Verzeichnis hinzufügen
        </Button>
      </div>
      {error && !data && <ErrorNote error={error} onRetry={() => void refetch()} />}
      {!data && loading && <Loading />}
      {data && data.length === 0 && (
        <EmptyState title="Noch keine Verzeichnisse" description="Füge Ordner hinzu, in denen Archivist nach neuen Dokumenten suchen soll." />
      )}
      {(data ?? []).map((r) => (
        <DirectoryCard
          key={`${r.id}-${r.createdAt}-${r.enabled}-${r.recursive}-${r.llmAllowed}-${r.maxFileSizeMb}`}
          root={r}
          onChanged={() => void refetch()}
          onRemove={() => setRemoving(r)}
        />
      ))}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Verzeichnis entfernen?"
        description="Archivist durchsucht diesen Ordner nicht mehr. Deine Dateien bleiben unverändert."
        confirmLabel="Entfernen"
        destructive
        onConfirm={async () => {
          if (!removing) return;
          const ok = await run(() => call('scanner:removeDirectory', { id: removing.id }), { success: 'Verzeichnis entfernt.' });
          if (ok) {
            setRemoving(null);
            void refetch();
          }
        }}
      >
        {removing && <code className="break-all rounded bg-muted px-2 py-1 text-xs">{removing.path}</code>}
      </ConfirmDialog>
    </section>
  );
}
