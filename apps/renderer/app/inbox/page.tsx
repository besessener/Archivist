'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Inbox as InboxIcon } from 'lucide-react';
import { ArchiveDialog, defaultEdit, toArchiveItem, type ArchiveEdit } from '@/components/common/archive-dialog';
import { Page, PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorNote, Loading } from '@/components/common/states';
import { InboxDocCard } from '@/components/inbox/doc-card';
import { Button } from '@/components/ui/button';
import { CheckboxField } from '@/components/ui/checkbox';
import { Select } from '@/components/ui/select';
import { ARCHIVE_MODE_SHORT } from '@/lib/labels';
import { useQuery } from '@/lib/use-query';
import { useSettings } from '@/lib/use-settings';
import type { DocRecord } from '@/lib/types';
import type { ArchiveItemRequest, ArchiveMode, DocumentStatus } from '@archivist/shared';
import { cn } from '@/lib/utils';

const INBOX_STATUSES: DocumentStatus[] = ['staged', 'analyzing', 'proposed', 'failed', 'quarantined'];
const FILTERS: Array<{ id: DocumentStatus | 'all'; label: string }> = [
  { id: 'all', label: 'Alle' },
  { id: 'staged', label: 'Neu' },
  { id: 'analyzing', label: 'Wird analysiert' },
  { id: 'proposed', label: 'Vorschlag bereit' },
  { id: 'failed', label: 'Fehlgeschlagen' },
  { id: 'quarantined', label: 'Quarantäne' },
];

export default function InboxPage() {
  const { data, loading, error, refetch } = useQuery('documents:list', { limit: 1000 }, { scopes: ['documents'], jobs: true });
  const [filter, setFilter] = useState<DocumentStatus | 'all'>('all');
  const [edits, setEdits] = useState<Record<string, ArchiveEdit>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialogItems, setDialogItems] = useState<ArchiveItemRequest[] | null>(null);
  const { settings } = useSettings();

  const docs = useMemo(() => (data ?? []).filter((d) => INBOX_STATUSES.includes(d.status)), [data]);
  const shown = docs.filter((d) => filter === 'all' || d.status === filter);
  const archivable = shown.filter((d) => d.status === 'staged' || d.status === 'proposed');
  const getEdit = (d: DocRecord): ArchiveEdit => edits[d.id] ?? defaultEdit(d);
  const selectedDocs = archivable.filter((d) => selected.has(d.id));

  function openFor(list: DocRecord[]) {
    setDialogItems(list.map((d) => toArchiveItem(d, getEdit(d))));
  }

  return (
    <Page>
      <PageHeader
        title="Inbox"
        description="Neue Dokumente warten hier auf Ihre Entscheidung. Archivist macht Vorschläge – es wird nichts verschoben, bevor Sie es bestätigen."
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              data-testid={`inbox-filter-${f.id}`}
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring',
                filter === f.id ? 'border-primary bg-primary/12 text-primary' : 'hover:bg-accent',
              )}
            >
              {f.label}
              {f.id !== 'all' && ` (${docs.filter((d) => d.status === f.id).length})`}
            </button>
          ))}
        </div>
      </div>

      {archivable.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3" data-testid="inbox-batchbar">
          <CheckboxField
            checked={selectedDocs.length === archivable.length && archivable.length > 0}
            onCheckedChange={(v) => setSelected(v === true ? new Set(archivable.map((d) => d.id)) : new Set())}
            label="Alle auswählen"
            data-testid="inbox-select-all"
          />
          <span className="text-sm text-muted-foreground">{selectedDocs.length} ausgewählt</span>
          <div className="w-52">
            <Select
              aria-label="Aktion für alle Ausgewählten"
              value=""
              disabled={selectedDocs.length === 0}
              onChange={(e) => {
                const mode = e.target.value as ArchiveMode;
                if (!mode) return;
                setEdits((prev) => {
                  const next = { ...prev };
                  for (const d of selectedDocs) next[d.id] = { ...(prev[d.id] ?? defaultEdit(d)), mode };
                  return next;
                });
              }}
            >
              <option value="">Aktion für Auswahl …</option>
              {(Object.keys(ARCHIVE_MODE_SHORT) as ArchiveMode[]).map((m) => (
                <option key={m} value={m}>
                  {ARCHIVE_MODE_SHORT[m]}
                </option>
              ))}
            </Select>
          </div>
          <Button size="sm" disabled={selectedDocs.length === 0} onClick={() => openFor(selectedDocs)} data-testid="inbox-archive-selected">
            Ausgewählte archivieren …
          </Button>
        </div>
      )}

      {error && !data && <ErrorNote error={error} onRetry={() => void refetch()} />}
      {!data && loading && <Loading />}
      {data && shown.length === 0 && (
        <EmptyState
          icon={<InboxIcon />}
          title="Die Inbox ist leer"
          description="Ziehen Sie Dateien in das Fenster oder wählen Sie im Chat „Dateien auswählen“, um Dokumente hinzuzufügen."
          action={
            <Button asChild variant="outline">
              <Link href="/chat/">Zum Chat</Link>
            </Button>
          }
        />
      )}
      <ul className="flex flex-col gap-3">
        {shown.map((d) => (
          <InboxDocCard
            key={d.id}
            doc={d}
            edit={getEdit(d)}
            onEdit={(e) => setEdits((prev) => ({ ...prev, [d.id]: e }))}
            selected={selected.has(d.id)}
            onSelect={(v) =>
              setSelected((prev) => {
                const next = new Set(prev);
                if (v) next.add(d.id);
                else next.delete(d.id);
                return next;
              })
            }
            onArchive={() => openFor([d])}
            onChanged={() => void refetch()}
            llmMode={settings?.privacy.llmMode ?? 'confirm'}
            llmBaseUrl={settings?.llm.baseUrl ?? ''}
          />
        ))}
      </ul>

      <ArchiveDialog
        open={dialogItems !== null}
        onOpenChange={(o) => {
          if (!o) setDialogItems(null);
        }}
        items={dialogItems ?? []}
        onDone={() => {
          setSelected(new Set());
          void refetch();
        }}
      />
    </Page>
  );
}
