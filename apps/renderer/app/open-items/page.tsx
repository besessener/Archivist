'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, ListChecks, Plus } from 'lucide-react';
import { BulkAssignBar, useSelection } from '@/components/common/bulk-assign';
import { useSubjectsOf } from '@/components/common/extra-subjects';
import { LoadMore } from '@/components/common/load-more';
import { GROUP_HEADING, Page, PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorNote, Loading } from '@/components/common/states';
import { CloseDialog, DeleteDialog, RelatedDialog, ReminderDialog } from '@/components/open-items/item-dialogs';
import { ItemFormDialog } from '@/components/open-items/item-form-dialog';
import { OpenItemRow, type OpenItemActions } from '@/components/open-items/item-row';
import { UpcomingReminders } from '@/components/reminders/upcoming-reminders';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useApp } from '@/lib/app-context';
import { dueWindow, groupOf, type DueWindow, type OpenItemGroup } from '@/lib/open-item-groups';
import { usePageWindow, useWindowedQuery } from '@/lib/use-page-window';
import { useQuery } from '@/lib/use-query';
import { useSettings } from '@/lib/use-settings';
import type { OpenItemRecord } from '@/lib/types';
import { cn } from '@/lib/utils';

const GROUPS = ['overdue', 'due', 'open', 'done'] as const;
const GROUP_LABELS: Record<OpenItemGroup, string> = { overdue: 'Überfällig', due: 'Bald fällig', open: 'Offen', done: 'Erledigt' };

function groupItems(items: OpenItemRecord[], window: DueWindow): Record<OpenItemGroup, OpenItemRecord[]> {
  const groups: Record<OpenItemGroup, OpenItemRecord[]> = { overdue: [], due: [], open: [], done: [] };
  for (const item of items) groups[groupOf(item, window)].push(item);
  for (const key of ['overdue', 'due', 'open'] as const) groups[key].sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999'));
  return groups;
}

export default function OpenItemsPage() {
  const paging = usePageWindow('open-items');
  const { data, loading, error, refetch } = useWindowedQuery('openItems:list', { filter: {}, window: paging.window, scopes: ['openItems', 'reminders'] });
  const total = useQuery('openItems:count', {}, { scopes: ['openItems', 'reminders'] });
  const [doneExpanded, setDoneExpanded] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editItem, setEditItem] = useState<OpenItemRecord | null>(null);
  const [closeItem, setCloseItem] = useState<OpenItemRecord | null>(null);
  const [deleteItem, setDeleteItem] = useState<OpenItemRecord | null>(null);
  const [remindItem, setRemindItem] = useState<OpenItemRecord | null>(null);
  const [relatedItem, setRelatedItem] = useState<OpenItemRecord | null>(null);
  const { settings } = useSettings();
  const { status } = useApp();
  // do not lock prematurely while the status is loading – the main process checks anyway
  const llm = { mode: settings?.privacy.llmMode ?? 'confirm', configured: status ? status.llm.configured : true };

  const selection = useSelection();
  const subjects = useSubjectsOf(useMemo(() => (data ?? []).map((item) => item.id), [data]));
  const dueSoonDays = settings?.consistency.dueSoonDays;
  const groups = useMemo(() => groupItems(data ?? [], dueWindow(dueSoonDays ?? 7)), [data, dueSoonDays]);
  const actions: OpenItemActions = {
    onEdit: setEditItem,
    onRemind: setRemindItem,
    onRelated: setRelatedItem,
    onClose: setCloseItem,
    onDelete: setDeleteItem,
    onChanged: () => void refetch(),
  };

  return (
    <Page>
      <PageHeader
        title="Offene Punkte"
        description="Alles, was noch zu klären oder zu tun ist – mit Verantwortlichen, Terminen und Erinnerungen."
        actions={
          <Button onClick={() => setCreateOpen(true)} data-testid="open-item-new">
            <Plus aria-hidden /> Neuer Punkt
          </Button>
        }
      />
      <UpcomingReminders targetType="open_item" className="mb-6" />
      {error && !data && <ErrorNote error={error} onRetry={() => void refetch()} />}
      {!data && loading && <Loading />}
      {data && data.length === 0 && (
        <EmptyState
          icon={<ListChecks />}
          title="Keine offenen Punkte"
          description="Sag im Chat zum Beispiel „Wir müssen noch klären, …“ oder lege hier einen Punkt an."
        />
      )}
      <BulkAssignBar ids={selection.ids} noun={['offener Punkt', 'offene Punkte']} onClear={selection.clear} onDone={() => void refetch()} />
      <div className="flex flex-col gap-8">
        {GROUPS.map((group) =>
          groups[group].length === 0 ? null : (
            <section key={group} aria-labelledby={`grp-${group}`} data-testid={`open-group-${group}`}>
              <h2 id={`grp-${group}`} className={cn(GROUP_HEADING, 'mb-2', group === 'overdue' && 'text-destructive')}>
                {group === 'done' ? (
                  <button
                    type="button"
                    aria-expanded={doneExpanded}
                    aria-controls="open-group-done-list"
                    onClick={() => setDoneExpanded((expanded) => !expanded)}
                    className="flex items-center gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-ring"
                    data-testid="open-group-done-toggle"
                  >
                    {doneExpanded ? <ChevronDown className="size-4" aria-hidden /> : <ChevronRight className="size-4" aria-hidden />}
                    {GROUP_LABELS[group]} <Badge variant="secondary">{groups[group].length}</Badge>
                  </button>
                ) : (
                  <span className="flex items-center gap-2">
                    {GROUP_LABELS[group]} <Badge variant={group === 'overdue' ? 'danger' : 'secondary'}>{groups[group].length}</Badge>
                  </span>
                )}
              </h2>
              <ul id={`open-group-${group}-list`} className={group === 'done' && !doneExpanded ? 'hidden' : 'flex flex-col gap-2'}>
                {groups[group].map((item) => (
                  <OpenItemRow
                    key={item.id}
                    item={item}
                    group={group}
                    selected={selection.has(item.id)}
                    onSelect={(selected) => selection.toggle(item.id, selected)}
                    subjects={subjects[item.id]}
                    llm={llm}
                    actions={actions}
                  />
                ))}
              </ul>
            </section>
          ),
        )}
      </div>

      <div className="mt-4">
        <LoadMore shown={data?.length ?? 0} total={total.data ?? 0} noun="offenen Punkten" onMore={paging.more} loading={loading} testId="open-items" />
      </div>

      <ItemFormDialog key={`c-${createOpen}`} open={createOpen} onOpenChange={setCreateOpen} item={null} onSaved={() => void refetch()} />
      {editItem && <ItemFormDialog key={editItem.id} open onOpenChange={(open) => !open && setEditItem(null)} item={editItem} onSaved={() => void refetch()} />}
      <CloseDialog item={closeItem} onClose={() => setCloseItem(null)} onDone={() => void refetch()} />
      <DeleteDialog item={deleteItem} onClose={() => setDeleteItem(null)} onDone={() => void refetch()} />
      <ReminderDialog item={remindItem} onClose={() => setRemindItem(null)} onDone={() => void refetch()} />
      <RelatedDialog item={relatedItem} onClose={() => setRelatedItem(null)} />
    </Page>
  );
}
