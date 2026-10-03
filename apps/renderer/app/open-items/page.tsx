'use client';

import { useMemo, useState } from 'react';
import { ListChecks, Plus } from 'lucide-react';
import { BulkAssignBar, useSelection } from '@/components/common/bulk-assign';
import { useSubjectsOf } from '@/components/common/extra-subjects';
import { Page, PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorNote, Loading } from '@/components/common/states';
import { CloseDialog, RelatedDialog, ReminderDialog } from '@/components/open-items/item-dialogs';
import { ItemFormDialog } from '@/components/open-items/item-form-dialog';
import { OpenItemRow, groupOf, type OpenItemActions, type OpenItemGroup } from '@/components/open-items/item-row';
import { UpcomingReminders } from '@/components/reminders/upcoming-reminders';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useApp } from '@/lib/app-context';
import { useQuery } from '@/lib/use-query';
import { useSettings } from '@/lib/use-settings';
import type { OpenItemRecord } from '@/lib/types';

const GROUPS = ['overdue', 'due', 'open', 'done'] as const;
const GROUP_LABELS: Record<OpenItemGroup, string> = { overdue: 'Überfällig', due: 'Bald fällig', open: 'Offen', done: 'Erledigt' };

function groupItems(items: OpenItemRecord[]): Record<OpenItemGroup, OpenItemRecord[]> {
  const groups: Record<OpenItemGroup, OpenItemRecord[]> = { overdue: [], due: [], open: [], done: [] };
  for (const item of items) groups[groupOf(item)].push(item);
  for (const key of ['overdue', 'due', 'open'] as const) groups[key].sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999'));
  return groups;
}

export default function OpenItemsPage() {
  const { data, loading, error, refetch } = useQuery('openItems:list', {}, { scopes: ['openItems', 'reminders'] });
  const [createOpen, setCreateOpen] = useState(false);
  const [editItem, setEditItem] = useState<OpenItemRecord | null>(null);
  const [closeItem, setCloseItem] = useState<OpenItemRecord | null>(null);
  const [remindItem, setRemindItem] = useState<OpenItemRecord | null>(null);
  const [relatedItem, setRelatedItem] = useState<OpenItemRecord | null>(null);
  const { settings } = useSettings();
  const { status } = useApp();
  // do not lock prematurely while the status is loading – the main process checks anyway
  const llm = { mode: settings?.privacy.llmMode ?? 'confirm', configured: status ? status.llm.configured : true };

  const selection = useSelection();
  const subjects = useSubjectsOf(useMemo(() => (data ?? []).map((item) => item.id), [data]));
  const groups = useMemo(() => groupItems(data ?? []), [data]);
  const actions: OpenItemActions = {
    onEdit: setEditItem,
    onRemind: setRemindItem,
    onRelated: setRelatedItem,
    onClose: setCloseItem,
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
              <h2 id={`grp-${group}`} className="mb-2 flex items-center gap-2 text-sm font-semibold">
                {GROUP_LABELS[group]} <Badge variant={group === 'overdue' ? 'danger' : 'secondary'}>{groups[group].length}</Badge>
              </h2>
              <ul className="flex flex-col gap-2">
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

      <ItemFormDialog key={`c-${createOpen}`} open={createOpen} onOpenChange={setCreateOpen} item={null} onSaved={() => void refetch()} />
      {editItem && <ItemFormDialog key={editItem.id} open onOpenChange={(open) => !open && setEditItem(null)} item={editItem} onSaved={() => void refetch()} />}
      <CloseDialog item={closeItem} onClose={() => setCloseItem(null)} onDone={() => void refetch()} />
      <ReminderDialog item={remindItem} onClose={() => setRemindItem(null)} onDone={() => void refetch()} />
      <RelatedDialog item={relatedItem} onClose={() => setRelatedItem(null)} />
    </Page>
  );
}
