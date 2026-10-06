'use client';

import { BulkAssignBar, useSelection } from '@/components/common/bulk-assign';
import { Checkbox } from '@/components/ui/checkbox';
import { useMemo, useState } from 'react';
import { CalendarDays, FileText, Gavel, ListChecks, Pencil, Plus, ShieldAlert, StickyNote, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EventFormDialog, eventPatch } from '@/components/events/event-form-dialog';
import { EntityChip } from '@/components/common/entity-chip';
import { Markdown } from '@/components/common/markdown';
import { Page, PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorNote, Field, Loading } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { call } from '@/lib/ipc';
import { useRun } from '@/lib/use-run';
import { useToast } from '@/lib/toast';
import { formatLongDate } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import type { Tone } from '@/lib/nav';
import type { IpcOutput } from '@archivist/shared';

type Entry = IpcOutput<'timeline:get'>[number];
type EventRecord = IpcOutput<'events:create'>;

/** Entries per page; "Ältere laden" extends the window by another page of older entries. */
const PAGE_SIZE = 200;
/** Must not exceed the `limit` maximum of the `timeline:get` channel. */
const MAX_ENTRIES = 10000;

const KIND: Record<Entry['kind'], { icon: React.ComponentType<{ className?: string }>; label: string; tone: Tone }> = {
  document: { icon: FileText, label: 'Dokument', tone: 'document' },
  decision: { icon: Gavel, label: 'Entscheidung', tone: 'decision' },
  open_item: { icon: ListChecks, label: 'Offener Punkt', tone: 'task' },
  event: { icon: CalendarDays, label: 'Ereignis', tone: 'neutral' },
  contradiction: { icon: ShieldAlert, label: 'Widerspruch', tone: 'danger' },
  note: { icon: StickyNote, label: 'Notiz', tone: 'neutral' },
};

export default function TimelinePage() {
  const [topicId, setTopicId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [pages, setPages] = useState(1);
  const limit = Math.min(pages * PAGE_SIZE, MAX_ENTRIES);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [editEvent, setEditEvent] = useState<EventRecord | null>(null);
  const { run } = useRun();
  const { toast } = useToast();
  const topics = useQuery('knowledge:listEntities', { type: 'topic', limit: 1000 }, { scopes: ['knowledge'] });
  const projects = useQuery('knowledge:listEntities', { type: 'project', limit: 1000 }, { scopes: ['knowledge'] });
  const selection = useSelection();
  const tl = useQuery(
    'timeline:get',
    {
      ...(topicId ? { topicId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      limit,
    },
    { scopes: ['documents', 'decisions', 'openItems', 'knowledge', 'contradictions', 'events'] },
  );

  // a full page means older entries may exist; while a larger window loads, the smaller result still shows, so keep the button
  const shown = tl.data?.length ?? 0;
  const canLoadOlder = limit < MAX_ENTRIES && (shown >= limit || (tl.loading && pages > 1 && shown >= limit - PAGE_SIZE));
  const filter = (set: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    set(e.target.value);
    setPages(1);
  };

  // undated entries (decisions without any known date) get their own section instead of the capture day (#168)
  const { groups, undated } = useMemo(() => {
    const map = new Map<number, Entry[]>();
    const sorted = [...(tl.data ?? [])].sort((a, b) => b.date.localeCompare(a.date));
    for (const e of sorted.filter((x) => !x.undated)) {
      const list = map.get(e.year) ?? [];
      list.push(e);
      map.set(e.year, list);
    }
    return { groups: [...map.entries()].sort((a, b) => b[0] - a[0]), undated: sorted.filter((x) => x.undated) };
  }, [tl.data]);

  async function openEdit(eventId: string) {
    const all = await run(() => call('events:list', {}));
    if (!all) return;
    const found = all.find((ev) => ev.id === eventId);
    if (found) setEditEvent(found);
    else toast({ variant: 'info', title: 'Dieses Ereignis gibt es nicht mehr.' });
  }

  const eventIdOf = (entryId: string) => entryId.replace(/^event:/, '');

  function renderEntry(e: Entry) {
    const k = KIND[e.kind];
    return (
      <li key={e.id} className="relative" data-testid="timeline-entry" data-kind={e.kind}>
        <span data-tone={k.tone} className="absolute -left-[2.15rem] flex size-6 items-center justify-center rounded-full border border-tone/40 bg-card">
          <k.icon className="size-3.5 text-tone" />
        </span>
        <p className="text-xs text-muted-foreground">
          {e.undated ? `ohne Datum, erfasst am ${formatLongDate(e.date)}` : formatLongDate(e.date)} · {k.label}
        </p>
        <p className="flex items-center gap-2 font-medium">
          {e.kind === 'event' && (
            <Checkbox
              checked={selection.has(eventIdOf(e.id))}
              onCheckedChange={(v) => selection.toggle(eventIdOf(e.id), v === true)}
              aria-label={`${e.title} auswählen`}
              data-testid="event-select"
            />
          )}
          {e.title}
          {e.kind === 'event' && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label="Ereignis bearbeiten"
              onClick={() => void openEdit(e.id.replace(/^event:/, ''))}
              data-testid="event-edit"
            >
              <Pencil className="size-3.5" />
            </Button>
          )}
          {e.kind === 'event' && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label="Ereignis löschen"
              onClick={() => setDeleteId(e.id.replace(/^event:/, ''))}
              data-testid="event-delete"
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </p>
        {e.description && <Markdown text={e.description} className="mt-0.5 text-sm text-muted-foreground" testId="timeline-description" />}
        {e.refs.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {e.refs.map((r) => (
              <EntityChip key={`${r.type}-${r.id}`} type={r.type} id={r.id} label={r.label} detail={r.detail} />
            ))}
          </div>
        )}
      </li>
    );
  }

  return (
    <Page>
      <PageHeader
        title="Timeline"
        description="Was wann passiert ist – Dokumente, Entscheidungen, offene Punkte und Ereignisse in zeitlicher Reihenfolge."
        actions={
          <Button onClick={() => setCreateOpen(true)} data-testid="event-add">
            <Plus className="size-4" /> Ereignis hinzufügen
          </Button>
        }
      />
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Thema" htmlFor="tl-topic">
          <Select id="tl-topic" value={topicId} onChange={filter(setTopicId)} data-testid="timeline-topic">
            <option value="">Alle Themen</option>
            {(topics.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Projekt" htmlFor="tl-project">
          <Select id="tl-project" value={projectId} onChange={filter(setProjectId)} data-testid="timeline-project">
            <option value="">Alle Projekte</option>
            {(projects.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Von" htmlFor="tl-from">
          <Input id="tl-from" type="date" value={from} onChange={filter(setFrom)} data-testid="timeline-from" />
        </Field>
        <Field label="Bis" htmlFor="tl-to">
          <Input id="tl-to" type="date" value={to} onChange={filter(setTo)} data-testid="timeline-to" />
        </Field>
      </div>
      {tl.error && !tl.data && <ErrorNote error={tl.error} onRetry={() => void tl.refetch()} />}
      {!tl.data && tl.loading && <Loading />}
      {tl.data && groups.length === 0 && undated.length === 0 && (
        <EmptyState icon={<CalendarDays />} title="Keine Einträge" description="Für diesen Filter gibt es keine Einträge in der Timeline." />
      )}
      <BulkAssignBar ids={selection.ids} noun={['Ereignis', 'Ereignisse']} onClear={selection.clear} onDone={() => void tl.refetch()} />
      <div className="flex flex-col gap-8" data-testid="timeline">
        {groups.map(([year, entries]) => (
          <section key={year} aria-labelledby={`year-${year}`}>
            <h2 id={`year-${year}`} className="mb-3 text-lg font-semibold">
              {year}
            </h2>
            <ol className="relative ml-3 flex flex-col gap-4 border-l pl-6">{entries.map((e) => renderEntry(e))}</ol>
          </section>
        ))}
        {undated.length > 0 && (
          <section aria-labelledby="year-undated" data-testid="timeline-undated">
            <h2 id="year-undated" className="mb-3 text-lg font-semibold">
              Ohne Datum
            </h2>
            <ol className="relative ml-3 flex flex-col gap-4 border-l pl-6">{undated.map((e) => renderEntry(e))}</ol>
          </section>
        )}
      </div>
      {tl.data && canLoadOlder && (
        <div className="mt-8 flex flex-col items-center gap-2">
          <p className="text-xs text-muted-foreground">Angezeigt werden die neuesten {shown} Einträge.</p>
          <Button variant="outline" onClick={() => setPages((p) => p + 1)} disabled={tl.loading} data-testid="timeline-load-older">
            Ältere laden
          </Button>
        </div>
      )}
      <EventFormDialog
        key={`e-${createOpen}`}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSubmit={async (input) => {
          const out = await run(() => call('events:create', input), { success: 'Ereignis eingetragen.' });
          if (out) void tl.refetch();
          return out?.id ?? false;
        }}
      />
      {editEvent && (
        <EventFormDialog
          key={editEvent.id}
          open
          event={editEvent}
          onOpenChange={(o) => !o && setEditEvent(null)}
          onSubmit={async (input) => {
            const patch = eventPatch(editEvent, input);
            if (Object.keys(patch).length === 0) return true;
            const out = await run(() => call('events:update', { id: editEvent.id, patch }), { success: 'Änderungen gespeichert.' });
            if (out) void tl.refetch();
            return out !== undefined;
          }}
        />
      )}
      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={(o) => !o && setDeleteId(null)}
        title="Ereignis löschen?"
        description="Das Ereignis wird aus Timeline, Suche und Wissensgraph entfernt. Rückgängig machen kannst du das unter Einstellungen → Änderungsprotokoll."
        confirmLabel="Löschen"
        destructive
        onConfirm={async () => {
          if (!deleteId) return;
          await run(() => call('events:delete', { id: deleteId, confirmed: true }), { success: 'Ereignis gelöscht.' });
          setDeleteId(null);
          void tl.refetch();
        }}
      />
    </Page>
  );
}
