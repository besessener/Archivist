'use client';

import { useMemo, useState } from 'react';
import { CalendarDays, FileText, Gavel, ListChecks, Plus, ShieldAlert, StickyNote, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EventFormDialog } from '@/components/events/event-form-dialog';
import { EntityChip } from '@/components/common/entity-chip';
import { Page, PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorNote, Field, Loading } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { call } from '@/lib/ipc';
import { useRun } from '@/lib/use-run';
import { formatLongDate } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import type { IpcOutput } from '@archivist/shared';

type Entry = IpcOutput<'timeline:get'>[number];

const KIND: Record<Entry['kind'], { icon: React.ComponentType<{ className?: string }>; label: string }> = {
  document: { icon: FileText, label: 'Dokument' },
  decision: { icon: Gavel, label: 'Entscheidung' },
  open_item: { icon: ListChecks, label: 'Offener Punkt' },
  event: { icon: CalendarDays, label: 'Ereignis' },
  contradiction: { icon: ShieldAlert, label: 'Widerspruch' },
  note: { icon: StickyNote, label: 'Notiz' },
};

export default function TimelinePage() {
  const [topicId, setTopicId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const { run } = useRun();
  const topics = useQuery('knowledge:listEntities', { type: 'topic', limit: 1000 }, { scopes: ['knowledge'] });
  const projects = useQuery('knowledge:listEntities', { type: 'project', limit: 1000 }, { scopes: ['knowledge'] });
  const tl = useQuery(
    'timeline:get',
    {
      ...(topicId ? { topicId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      limit: 500,
    },
    { scopes: ['documents', 'decisions', 'openItems', 'knowledge', 'contradictions', 'events'] },
  );

  const groups = useMemo(() => {
    const map = new Map<number, Entry[]>();
    for (const e of [...(tl.data ?? [])].sort((a, b) => b.date.localeCompare(a.date))) {
      const list = map.get(e.year) ?? [];
      list.push(e);
      map.set(e.year, list);
    }
    return [...map.entries()].sort((a, b) => b[0] - a[0]);
  }, [tl.data]);

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
          <Select id="tl-topic" value={topicId} onChange={(e) => setTopicId(e.target.value)} data-testid="timeline-topic">
            <option value="">Alle Themen</option>
            {(topics.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Projekt" htmlFor="tl-project">
          <Select id="tl-project" value={projectId} onChange={(e) => setProjectId(e.target.value)} data-testid="timeline-project">
            <option value="">Alle Projekte</option>
            {(projects.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Von" htmlFor="tl-from">
          <Input id="tl-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="timeline-from" />
        </Field>
        <Field label="Bis" htmlFor="tl-to">
          <Input id="tl-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} data-testid="timeline-to" />
        </Field>
      </div>
      {tl.error && !tl.data && <ErrorNote error={tl.error} onRetry={() => void tl.refetch()} />}
      {!tl.data && tl.loading && <Loading />}
      {tl.data && groups.length === 0 && (
        <EmptyState icon={<CalendarDays />} title="Keine Einträge" description="Für diesen Filter gibt es keine Einträge in der Timeline." />
      )}
      <div className="flex flex-col gap-8" data-testid="timeline">
        {groups.map(([year, entries]) => (
          <section key={year} aria-labelledby={`year-${year}`}>
            <h2 id={`year-${year}`} className="mb-3 text-lg font-semibold">
              {year}
            </h2>
            <ol className="relative ml-3 flex flex-col gap-4 border-l pl-6">
              {entries.map((e) => {
                const k = KIND[e.kind];
                return (
                  <li key={e.id} className="relative" data-testid="timeline-entry" data-kind={e.kind}>
                    <span className="absolute -left-[2.15rem] flex size-6 items-center justify-center rounded-full border bg-card">
                      <k.icon className="size-3.5 text-primary" />
                    </span>
                    <p className="text-xs text-muted-foreground">
                      {formatLongDate(e.date)} · {k.label}
                    </p>
                    <p className="flex items-center gap-2 font-medium">
                      {e.title}
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
                    {e.description && <p className="mt-0.5 text-sm text-muted-foreground">{e.description}</p>}
                    {e.refs.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {e.refs.map((r) => (
                          <EntityChip key={`${r.type}-${r.id}`} type={r.type} id={r.id} label={r.label} detail={r.detail} />
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>
      <EventFormDialog
        key={`e-${createOpen}`}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSubmit={async (input) => {
          const out = await run(() => call('events:create', input), { success: 'Ereignis eingetragen.' });
          if (out) void tl.refetch();
          return out !== undefined;
        }}
      />
      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={(o) => !o && setDeleteId(null)}
        title="Ereignis löschen?"
        description="Das Ereignis wird aus Timeline, Suche und Wissensgraph entfernt."
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
