'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search, X } from 'lucide-react';
import type { DocumentStatus } from '@archivist/shared';
import { useSubjectsOf } from '@/components/common/extra-subjects';
import { Page, PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorNote, Loading } from '@/components/common/states';
import { BulkBar } from '@/components/documents/bulk-bar';
import { DocumentDialog } from '@/components/documents/document-dialog';
import { DocumentsTable } from '@/components/documents/documents-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useDebounced } from '@/lib/use-debounced';
import { useQuery } from '@/lib/use-query';

const ARCHIVED: DocumentStatus[] = ['archived', 'indexed_only'];
/** Documents per page; „Mehr laden“ extends the window by another page, up to the IPC limit. */
const PAGE_SIZE = 100;
const MAX_LIMIT = 1000;

function DocumentsInner() {
  const router = useRouter();
  const params = useSearchParams();
  const topicId = params.get('topicId');
  const openId = params.get('id');
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const query = useDebounced(search.trim(), 300);
  // filtered in the database so newer inbox entries cannot hide archived documents; the total tells whether the list is complete (#222)
  const filter = { statuses: ARCHIVED, ...(query ? { query } : {}), ...(topicId ? { topicId } : {}) };
  const [pages, setPages] = useState(1);
  const limit = Math.min(MAX_LIMIT, pages * PAGE_SIZE);
  useEffect(() => setPages(1), [query, topicId]);
  const list = useQuery('documents:list', { ...filter, limit }, { scopes: ['documents'] });
  const total = useQuery('documents:count', filter, { scopes: ['documents'] });
  const proposals = useQuery('documents:reanalysisPending', {}, { scopes: ['documents'] });
  const topic = useQuery('knowledge:getEntity', topicId ? { id: topicId } : undefined, { enabled: !!topicId });

  const docs = list.data ?? [];
  const types = [...new Set(docs.map((doc) => doc.docType).filter((docType): docType is string => !!docType))].sort();
  const shown = docs.filter((doc) => !type || doc.docType === type);
  const subjects = useSubjectsOf(useMemo(() => shown.map((doc) => doc.id), [shown]));
  // Multi-selection (#291, #304): only documents that are currently shown count
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectedDocs = shown.filter((doc) => selected.has(doc.id));
  const topicSuffix = topicId ? `&topicId=${encodeURIComponent(topicId)}` : '';

  return (
    <Page wide>
      <PageHeader title="Dokumente" description="Alle archivierten und indexierten Dokumente. Klicke auf eine Zeile für Einzelheiten." />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Dokumente durchsuchen …"
            aria-label="Dokumente durchsuchen"
            className="pl-9"
            data-testid="documents-search"
          />
        </div>
        <div className="w-48">
          <Select value={type} onChange={(e) => setType(e.target.value)} aria-label="Dokumenttyp filtern" data-testid="documents-type-filter">
            <option value="">Alle Typen</option>
            {types.map((docType) => (
              <option key={docType} value={docType}>
                {docType}
              </option>
            ))}
          </Select>
        </div>
        {topicId && (
          <Badge variant="info" className="gap-2 py-1" data-testid="documents-topic-filter">
            Thema: {topic.data?.entity.name ?? '…'}
            <button
              type="button"
              aria-label="Themenfilter entfernen"
              className="rounded-full hover:bg-primary/20 focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => router.push('/documents/')}
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </Badge>
        )}
      </div>
      {(total.data ?? 0) > docs.length && (
        <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-muted-foreground" data-testid="documents-capped">
          <p>
            Angezeigt werden die neuesten {docs.length.toLocaleString('de-DE')} von {total.data!.toLocaleString('de-DE')} Dokumenten. Der Typfilter wirkt nur
            auf die geladenen Dokumente.
            {limit >= MAX_LIMIT && ' Grenze die Liste mit der Suche oder einem Thema ein, um ältere zu finden.'}
          </p>
          {limit < MAX_LIMIT && (
            <Button variant="outline" size="sm" onClick={() => setPages((p) => p + 1)} disabled={list.loading} data-testid="documents-load-more">
              Mehr laden
            </Button>
          )}
        </div>
      )}
      {list.error && !list.data && <ErrorNote error={list.error} onRetry={() => void list.refetch()} />}
      {!list.data && list.loading && <Loading />}
      {list.data && shown.length === 0 && (
        <EmptyState title="Keine Dokumente gefunden" description="Archivierte Dokumente erscheinen hier, sobald du Inbox-Einträge archiviert hast." />
      )}
      <BulkBar docs={selectedDocs} onClear={() => setSelected(new Set())} onDone={() => void list.refetch()} />
      {shown.length > 0 && (
        <DocumentsTable
          documents={shown}
          subjects={subjects}
          selected={selected}
          setSelected={setSelected}
          withProposal={new Set(proposals.data?.documentIds)}
          onOpen={(id) => router.push(`/documents/?id=${encodeURIComponent(id)}${topicSuffix}`)}
        />
      )}
      <DocumentDialog
        id={openId}
        onClose={() => router.push(topicId ? `/documents/?topicId=${encodeURIComponent(topicId)}` : '/documents/')}
        onChanged={() => void list.refetch()}
      />
    </Page>
  );
}

export default function DocumentsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <DocumentsInner />
    </Suspense>
  );
}
