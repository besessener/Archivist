'use client';

import { Suspense, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Inbox as InboxIcon } from 'lucide-react';
import { ArchiveDialog, defaultEdit, toArchiveItem, type ArchiveEdit } from '@/components/common/archive-dialog';
import { ArchiveAllButton } from '@/components/common/archive-all';
import { Page, PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorNote, Loading } from '@/components/common/states';
import { AnalyzeImportDialog } from '@/components/inbox/analyze-import-dialog';
import { InboxDocCard } from '@/components/inbox/doc-card';
import { Button } from '@/components/ui/button';
import { CheckboxField } from '@/components/ui/checkbox';
import { Select } from '@/components/ui/select';
import { ARCHIVE_MODE_SHORT } from '@/lib/labels';
import { uniqueById, usePagedQuery } from '@/lib/use-paged-query';
import { useQuery } from '@/lib/use-query';
import { useSettings } from '@/lib/use-settings';
import type { DocRecord } from '@/lib/types';
import type { ArchiveItemRequest, ArchiveMode, DocumentStatus } from '@archivist/shared';
import { cn, withMembership } from '@/lib/utils';

const PAGE_SIZE = 200;
const INBOX_STATUSES: DocumentStatus[] = ['staged', 'analyzing', 'proposed', 'failed', 'quarantined'];
const FILTERS: Array<{ id: DocumentStatus | 'all'; label: string }> = [
  { id: 'all', label: 'Alle' },
  { id: 'staged', label: 'Neu' },
  { id: 'analyzing', label: 'Wird analysiert' },
  { id: 'proposed', label: 'Vorschlag bereit' },
  { id: 'failed', label: 'Fehlgeschlagen' },
  { id: 'quarantined', label: 'Quarantäne' },
  { id: 'ignored', label: 'Ignoriert' },
];

function InboxContent() {
  const router = useRouter();
  const analyzeImportJob = useSearchParams().get('analyzeImport');
  const [filter, setFilter] = useState<DocumentStatus | 'all'>('all');
  // the filter runs in the database and the list is paged: nothing is cut off, „Mehr laden“ adds the next page (#228)
  const paged = usePagedQuery(
    'documents:list',
    { statuses: filter === 'all' ? INBOX_STATUSES : [filter] },
    { pageSize: PAGE_SIZE, scopes: ['documents'], jobs: true },
  );
  const { data: byStatus } = useQuery('documents:counts', {}, { scopes: ['documents'], jobs: true });
  const { loading, error, refetch } = paged;
  const data = useMemo(() => (paged.pages ? uniqueById(paged.pages) : undefined), [paged.pages]);
  const inboxTotal = INBOX_STATUSES.reduce((n, s) => n + (byStatus?.[s] ?? 0), 0);
  const shownTotal = filter === 'all' ? inboxTotal : (byStatus?.[filter] ?? 0);
  const [edits, setEdits] = useState<Record<string, ArchiveEdit>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialogItems, setDialogItems] = useState<ArchiveItemRequest[] | null>(null);
  const { settings } = useSettings();

  const shown = useMemo(() => data ?? [], [data]);
  const proposedTotal = byStatus?.proposed ?? 0;
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
        description="Neue Dokumente warten hier auf deine Entscheidung. Archivist macht Vorschläge – es wird nichts verschoben, bevor du es bestätigst."
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
              {f.id !== 'all' && ` (${byStatus?.[f.id] ?? 0})`}
            </button>
          ))}
        </div>
      </div>
      {proposedTotal > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2" data-testid="inbox-archive-all">
          <ArchiveAllButton source="inbox" testId="inbox-archive-all-open" />
          <span className="text-sm text-muted-foreground">{proposedTotal} Vorschläge warten auf deine Entscheidung.</span>
        </div>
      )}

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
          description="Zieh Dateien in das Fenster oder wähle im Chat „Dateien auswählen“, um Dokumente hinzuzufügen."
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
            onSelect={(checked) => setSelected((previous) => withMembership(previous, { value: d.id, present: checked }))}
            onArchive={() => openFor([d])}
            onChanged={() => void refetch()}
            llmMode={settings?.privacy.llmMode ?? 'confirm'}
            llmBaseUrl={settings?.llm.baseUrl ?? ''}
          />
        ))}
      </ul>
      {shown.length < shownTotal && (
        <div className="mt-4 flex flex-col items-center gap-2" data-testid="inbox-more">
          <p className="text-sm text-muted-foreground">
            {shown.length} von {shownTotal} wartenden Dokumenten angezeigt.
          </p>
          <Button variant="outline" onClick={paged.loadMore} disabled={loading} data-testid="inbox-load-more">
            Mehr laden
          </Button>
        </div>
      )}

      {analyzeImportJob && <AnalyzeImportDialog jobId={analyzeImportJob} onClose={() => router.replace('/inbox/')} />}
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

export default function InboxPage() {
  return (
    <Suspense fallback={<Loading />}>
      <InboxContent />
    </Suspense>
  );
}
