'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { DecisionStatus } from '@archivist/shared';
import { Plus, Search } from 'lucide-react';
import { BulkAssignBar, useSelection } from '@/components/common/bulk-assign';
import { useSubjectsOf } from '@/components/common/extra-subjects';
import { Page, PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorNote, Loading } from '@/components/common/states';
import { DecisionDetail } from '@/components/decisions/decision-detail';
import { DecisionFormDialog } from '@/components/decisions/decision-form';
import { DecisionListItem } from '@/components/decisions/decision-list-item';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DECISION_STATUS_LABELS } from '@/lib/labels';
import { useDebounced } from '@/lib/use-debounced';
import { useQuery } from '@/lib/use-query';
import type { DecisionRecord } from '@/lib/types';

function DecisionsInner() {
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get('id');
  const [status, setStatus] = useState<DecisionStatus | ''>('');
  const [search, setSearch] = useState('');
  const query = useDebounced(search.trim(), 300);
  const byFilter = useQuery('decisions:list', { ...(status ? { status } : {}) }, { scopes: ['decisions'], enabled: !query });
  const bySearch = useQuery('decisions:search', { query: query || 'x', limit: 50 }, { scopes: ['decisions'], enabled: !!query });
  const active = query ? bySearch : byFilter;
  const decisions = (active.data ?? []).filter((decision) => !query || !status || decision.status === status);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<DecisionRecord | null>(null);

  const sorted = [...decisions].sort((a, b) => {
    if ((a.status === 'draft') !== (b.status === 'draft')) return a.status === 'draft' ? -1 : 1;
    return (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt);
  });
  const subjects = useSubjectsOf(sorted.map((decision) => decision.id));
  const selection = useSelection();

  return (
    <Page wide className="lg:flex lg:h-full lg:flex-col">
      <PageHeader
        title="Entscheidungen"
        description="Was wurde wann, von wem und warum entschieden? Unvollständige Entwürfe sind hervorgehoben."
        actions={
          <Button
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
            data-testid="decision-new"
          >
            <Plus aria-hidden /> Entscheidung festhalten
          </Button>
        }
      />
      <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[22rem_1fr] lg:grid-rows-[minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3 lg:min-h-0">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Entscheidungen durchsuchen …"
              aria-label="Entscheidungen durchsuchen"
              className="pl-9"
              data-testid="decision-search"
            />
          </div>
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value as DecisionStatus | '')}
            aria-label="Status filtern"
            data-testid="decision-status-filter"
          >
            <option value="">Alle Status</option>
            {(Object.keys(DECISION_STATUS_LABELS) as DecisionStatus[]).map((option) => (
              <option key={option} value={option}>
                {DECISION_STATUS_LABELS[option]}
              </option>
            ))}
          </Select>
          {active.error && !active.data && <ErrorNote error={active.error} onRetry={() => void active.refetch()} />}
          {!active.data && active.loading && <Loading />}
          {active.data && sorted.length === 0 && (
            <EmptyState
              title="Keine Entscheidungen"
              description="Halte eine Entscheidung fest – im Chat mit „Wir haben entschieden, dass …“ oder hier mit dem Formular."
            />
          )}
          <BulkAssignBar ids={selection.ids} noun={['Entscheidung', 'Entscheidungen']} onClear={selection.clear} onDone={() => void active.refetch()} />
          <ul className="flex flex-col gap-2 lg:min-h-0 lg:flex-1 lg:overflow-y-auto" data-testid="decision-list">
            {sorted.map((decision) => (
              <DecisionListItem
                key={decision.id}
                decision={decision}
                current={decision.id === id}
                selected={selection.has(decision.id)}
                onSelect={(selected) => selection.toggle(decision.id, selected)}
                subjects={subjects[decision.id]}
              />
            ))}
          </ul>
        </div>
        <div className="min-w-0 lg:overflow-y-auto">
          {id ? (
            <DecisionDetail
              key={id}
              id={id}
              onEdit={(decision) => {
                setEditing(decision);
                setFormOpen(true);
              }}
              onDeleted={() => {
                void active.refetch();
                router.push('/decisions/');
              }}
            />
          ) : (
            <EmptyState title="Wähle eine Entscheidung" description="Klicke links auf einen Eintrag, um alle Einzelheiten zu sehen." />
          )}
        </div>
      </div>
      {formOpen && (
        <DecisionFormDialog
          key={editing?.id ?? 'new'}
          open={formOpen}
          onOpenChange={setFormOpen}
          decision={editing}
          onSaved={(saved) => {
            void active.refetch();
            router.push(`/decisions/?id=${encodeURIComponent(saved.id)}`);
          }}
        />
      )}
    </Page>
  );
}

export default function DecisionsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <DecisionsInner />
    </Suspense>
  );
}
