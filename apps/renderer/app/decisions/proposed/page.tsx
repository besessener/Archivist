'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Gavel } from 'lucide-react';
import { ActionCard } from '@/components/common/action-card';
import { Page, PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorNote, Loading } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { uniqueById, usePagedQuery } from '@/lib/use-paged-query';

const PAGE_SIZE = 20;

export default function ProposedDecisionsPage() {
  const router = useRouter();
  // paged by offset: one request may return at most 200 proposals (#181)
  const paged = usePagedQuery('actions:list', { status: 'proposed', actionType: 'record_decision' }, { pageSize: PAGE_SIZE, scopes: ['status'] });
  const { loading, error, refetch } = paged;
  const data = useMemo(() => (paged.pages ? uniqueById(paged.pages) : undefined), [paged.pages]);
  const hasMore = (paged.pages?.at(-1)?.length ?? 0) === PAGE_SIZE;

  return (
    <Page>
      <PageHeader
        title="Vorgeschlagene Entscheidungen"
        description="Entscheidungen, die ich in deinen Dokumenten erkannt habe. Sie werden erst festgehalten, wenn du sie bestätigst."
        actions={
          <Button variant="outline" onClick={() => router.push('/decisions/')} data-testid="proposed-decisions-back">
            <ArrowLeft aria-hidden /> Zu den Entscheidungen
          </Button>
        }
      />
      {error && !data && <ErrorNote error={error} onRetry={() => void refetch()} />}
      {!data && loading && <Loading />}
      {data && data.length === 0 && (
        <EmptyState
          icon={<Gavel />}
          title="Keine offenen Vorschläge"
          description="Wenn ich in einem archivierten Dokument eine Entscheidung finde, erscheint sie hier."
        />
      )}
      <ul className="flex flex-col gap-3" data-testid="proposed-decision-list">
        {(data ?? []).map((action) => (
          <li key={action.id} data-testid="proposed-decision">
            <ActionCard action={action} onResolved={() => void refetch()} />
          </li>
        ))}
      </ul>
      {hasMore && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" onClick={paged.loadMore} disabled={loading} data-testid="proposed-decisions-more">
            Weitere anzeigen
          </Button>
        </div>
      )}
    </Page>
  );
}
