'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { BellPlus, Check, ListChecks, MessageSquare, Pencil, Plus, X } from 'lucide-react';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { SolutionSection } from '@/components/open-items/solution';
import { Page, PageHeader } from '@/components/common/page-header';
import { QuickDate } from '@/components/common/quick-date';
import { UpcomingReminders } from '@/components/reminders/upcoming-reminders';
import { EmptyState, ErrorNote, Field, Loading } from '@/components/common/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CheckboxField } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useApp } from '@/lib/app-context';
import { call } from '@/lib/ipc';
import { OPEN_ITEM_STATUS_LABELS } from '@/lib/labels';
import { formatDate, relativeDay } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import { useSettings } from '@/lib/use-settings';
import type { OpenItemRecord } from '@/lib/types';
import { nonEmpty, toIsoDay } from '@/lib/utils';
import { EditableOpenItemStatus, isEditableOpenItemStatus } from '@archivist/shared';

type Group = 'overdue' | 'due' | 'open' | 'done';
const GROUP_LABELS: Record<Group, string> = { overdue: 'Überfällig', due: 'Bald fällig', open: 'Offen', done: 'Erledigt' };

function groupOf(i: OpenItemRecord): Group {
  if (i.status === 'resolved' || i.status === 'dismissed') return 'done';
  if (i.dueAt) {
    const today = toIsoDay(new Date());
    const due = i.dueAt.slice(0, 10);
    if (due < today) return 'overdue';
    const in7 = new Date();
    in7.setDate(in7.getDate() + 7);
    if (due <= toIsoDay(in7)) return 'due';
  }
  return 'open';
}

export default function OpenItemsPage() {
  const { data, loading, error, refetch } = useQuery('openItems:list', {}, { scopes: ['openItems', 'reminders'] });
  const [createOpen, setCreateOpen] = useState(false);
  const [editItem, setEditItem] = useState<OpenItemRecord | null>(null);
  const [closeItem, setCloseItem] = useState<OpenItemRecord | null>(null);
  const [remindItem, setRemindItem] = useState<OpenItemRecord | null>(null);
  const { settings } = useSettings();
  const { status } = useApp();
  const llmMode = settings?.privacy.llmMode ?? 'confirm';
  // solange der Status lädt, nicht vorschnell sperren – der Main-Prozess prüft ohnehin
  const llmConfigured = status ? status.llm.configured : true;

  const groups = useMemo(() => {
    const out: Record<Group, OpenItemRecord[]> = { overdue: [], due: [], open: [], done: [] };
    for (const i of data ?? []) out[groupOf(i)].push(i);
    for (const k of ['overdue', 'due', 'open'] as const) out[k].sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999'));
    return out;
  }, [data]);

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
          description="Sagen Sie im Chat zum Beispiel „Wir müssen noch klären, …“ oder legen Sie hier einen Punkt an."
        />
      )}
      <div className="flex flex-col gap-8">
        {(['overdue', 'due', 'open', 'done'] as const).map((g) =>
          groups[g].length === 0 ? null : (
            <section key={g} aria-labelledby={`grp-${g}`} data-testid={`open-group-${g}`}>
              <h2 id={`grp-${g}`} className="mb-2 flex items-center gap-2 text-sm font-semibold">
                {GROUP_LABELS[g]} <Badge variant={g === 'overdue' ? 'danger' : 'secondary'}>{groups[g].length}</Badge>
              </h2>
              <ul className="flex flex-col gap-2">
                {groups[g].map((i) => (
                  <li key={i.id} className="rounded-xl border bg-card p-3" data-testid="open-item-row" data-status={i.status} data-group={g}>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className={g === 'done' ? 'font-medium text-muted-foreground line-through' : 'font-medium'}>{i.title}</p>
                        {i.description && <p className="mt-0.5 whitespace-pre-line text-sm text-muted-foreground">{i.description}</p>}
                        {i.sourceConversationId && (
                          <Link
                            href={`/chat/?c=${encodeURIComponent(i.sourceConversationId)}`}
                            className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                            data-testid="open-item-chat-link"
                          >
                            <MessageSquare className="size-3.5" aria-hidden /> Im Chat ansehen
                          </Link>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {i.priority === 'high' && <Badge variant="danger">Hohe Priorität</Badge>}
                        {i.status !== 'open' && <Badge variant="outline">{OPEN_ITEM_STATUS_LABELS[i.status]}</Badge>}
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                      {i.responsibleName ? (
                        <Badge variant="outline">Verantwortlich: {i.responsibleName}</Badge>
                      ) : i.responsibleUnknown ? (
                        <Badge variant="secondary">Verantwortlicher bewusst unbekannt</Badge>
                      ) : g !== 'done' ? (
                        <Badge variant="warning" data-testid="badge-no-owner">
                          Kein Verantwortlicher
                        </Badge>
                      ) : null}
                      {i.dueAt ? (
                        <Badge variant={g === 'overdue' ? 'danger' : 'outline'}>
                          Termin: {formatDate(i.dueAt)} ({relativeDay(i.dueAt)})
                        </Badge>
                      ) : i.dueUnknown ? (
                        <Badge variant="secondary">Termin bewusst unbekannt</Badge>
                      ) : g !== 'done' ? (
                        <Badge variant="warning" data-testid="badge-no-due">
                          Kein Termin
                        </Badge>
                      ) : null}
                      {i.reminderAt && <Badge variant="info">Erinnerung {formatDate(i.reminderAt)}</Badge>}
                      {i.topicName && <Badge variant="outline">{i.topicName}</Badge>}
                      {i.projectName && <Badge variant="outline">{i.projectName}</Badge>}
                    </div>
                    {g !== 'done' && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" onClick={() => setEditItem(i)} data-testid="open-item-edit">
                          <Pencil aria-hidden /> Bearbeiten
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setRemindItem(i)} data-testid="open-item-remind">
                          <BellPlus aria-hidden /> Erinnern
                        </Button>
                        <Button size="sm" onClick={() => setCloseItem(i)} data-testid="open-item-close">
                          <Check aria-hidden /> Erledigt …
                        </Button>
                        <SolutionSection item={i} mode={llmMode} llmConfigured={llmConfigured} onChanged={() => void refetch()} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ),
        )}
      </div>

      <ItemFormDialog key={`c-${createOpen}`} open={createOpen} onOpenChange={setCreateOpen} item={null} onSaved={() => void refetch()} />
      {editItem && <ItemFormDialog key={editItem.id} open onOpenChange={(o) => !o && setEditItem(null)} item={editItem} onSaved={() => void refetch()} />}
      <CloseDialog item={closeItem} onClose={() => setCloseItem(null)} onDone={() => void refetch()} />
      <ReminderDialog item={remindItem} onClose={() => setRemindItem(null)} onDone={() => void refetch()} />
    </Page>
  );
}

function ItemFormDialog({
  open,
  onOpenChange,
  item,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  item: OpenItemRecord | null;
  onSaved: () => void;
}) {
  const { run, busy } = useRun();
  const [title, setTitle] = useState(item?.title ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [responsible, setResponsible] = useState(item?.responsibleName ?? '');
  const [respUnknown, setRespUnknown] = useState(item?.responsibleUnknown ?? false);
  const [dueAt, setDueAt] = useState(item?.dueAt?.slice(0, 10) ?? '');
  const [dueUnknown, setDueUnknown] = useState(item?.dueUnknown ?? false);
  const [priority, setPriority] = useState<'low' | 'normal' | 'high'>(item?.priority ?? 'normal');
  // closing is never part of an edit: it needs the confirmed „Erledigt …“ dialog (with undo)
  const [status, setStatus] = useState<EditableOpenItemStatus>(item && isEditableOpenItemStatus(item.status) ? item.status : 'open');
  const statusEditable = item !== null && isEditableOpenItemStatus(item.status);
  const [topic, setTopic] = useState(item?.topicName ?? '');
  const [project, setProject] = useState(item?.projectName ?? '');

  async function save() {
    const base = {
      title: title.trim(),
      description: nonEmpty(description) ?? null,
      topic: nonEmpty(topic) ?? null,
      project: nonEmpty(project) ?? null,
      responsible: respUnknown ? null : (nonEmpty(responsible) ?? null),
      dueAt: dueUnknown ? null : dueAt || null,
      priority,
    };
    const out = await run(
      () =>
        item
          ? call('openItems:update', {
              id: item.id,
              patch: { ...base, ...(statusEditable ? { status } : {}), responsibleUnknown: respUnknown, dueUnknown },
            })
          : call('openItems:create', base),
      { success: item ? 'Änderungen gespeichert.' : 'Offener Punkt angelegt.' },
    );
    if (out) {
      onSaved();
      onOpenChange(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" data-testid="open-item-form">
        <DialogHeader>
          <DialogTitle>{item ? 'Offenen Punkt bearbeiten' : 'Neuer offener Punkt'}</DialogTitle>
          <DialogDescription>Wenn Verantwortlicher oder Termin nicht feststehen, können Sie das ausdrücklich so markieren.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Was ist offen? *" htmlFor="oi-title" className="sm:col-span-2">
            <Input id="oi-title" value={title} onChange={(e) => setTitle(e.target.value)} data-testid="open-item-title" />
          </Field>
          <Field label="Beschreibung" htmlFor="oi-desc" className="sm:col-span-2">
            <Textarea id="oi-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label="Verantwortlich" htmlFor="oi-resp">
            <Input
              id="oi-resp"
              value={respUnknown ? '' : responsible}
              disabled={respUnknown}
              onChange={(e) => setResponsible(e.target.value)}
              data-testid="open-item-responsible"
            />
            <CheckboxField
              checked={respUnknown}
              onCheckedChange={(v) => setRespUnknown(v === true)}
              label="Verantwortlicher unbekannt"
              className="text-xs"
              data-testid="open-item-resp-unknown"
            />
          </Field>
          <Field label="Termin" htmlFor="oi-due">
            <Input
              id="oi-due"
              type="date"
              value={dueUnknown ? '' : dueAt}
              disabled={dueUnknown}
              onChange={(e) => setDueAt(e.target.value)}
              data-testid="open-item-due"
            />
            <CheckboxField
              checked={dueUnknown}
              onCheckedChange={(v) => setDueUnknown(v === true)}
              label="Termin unbekannt"
              className="text-xs"
              data-testid="open-item-due-unknown"
            />
          </Field>
          <Field label="Priorität" htmlFor="oi-prio">
            <Select id="oi-prio" value={priority} onChange={(e) => setPriority(e.target.value as 'low' | 'normal' | 'high')}>
              <option value="low">Niedrig</option>
              <option value="normal">Normal</option>
              <option value="high">Hoch</option>
            </Select>
          </Field>
          {statusEditable && (
            <Field label="Status" htmlFor="oi-status" hint="Zum Abschließen nutzen Sie „Erledigt …“.">
              <Select id="oi-status" value={status} onChange={(e) => setStatus(e.target.value as EditableOpenItemStatus)}>
                {EditableOpenItemStatus.options.map((s) => (
                  <option key={s} value={s}>
                    {OPEN_ITEM_STATUS_LABELS[s]}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Thema" htmlFor="oi-topic">
            <Input id="oi-topic" value={topic} onChange={(e) => setTopic(e.target.value)} />
          </Field>
          <Field label="Projekt" htmlFor="oi-project">
            <Input id="oi-project" value={project} onChange={(e) => setProject(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button disabled={busy || !title.trim()} onClick={() => void save()} data-testid="open-item-save">
            Speichern
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CloseDialog({ item, onClose, onDone }: { item: OpenItemRecord | null; onClose: () => void; onDone: () => void }) {
  const { run } = useRun();
  const [dismiss, setDismiss] = useState(false);
  return (
    <ConfirmDialog
      open={item !== null}
      onOpenChange={(o) => !o && onClose()}
      title="Punkt abschließen?"
      description={item ? `„${item.title}“ wird nicht mehr als offen angezeigt.` : undefined}
      confirmLabel={dismiss ? 'Als verworfen schließen' : 'Als erledigt schließen'}
      confirmTestId="open-item-close-confirm"
      onConfirm={async () => {
        if (!item) return;
        const out = await run(() => call('openItems:close', { id: item.id, status: dismiss ? 'dismissed' : 'resolved', confirmed: true }), {
          success: 'Punkt abgeschlossen.',
        });
        if (out) {
          onDone();
          onClose();
        }
      }}
    >
      <CheckboxField checked={dismiss} onCheckedChange={(v) => setDismiss(v === true)} label="Nicht erledigt, sondern verworfen (hat sich erübrigt)" />
    </ConfirmDialog>
  );
}

function ReminderDialog({ item, onClose, onDone }: { item: OpenItemRecord | null; onClose: () => void; onDone: () => void }) {
  const { run, busy } = useRun();
  const reminders = useQuery('reminders:list', { status: 'pending' }, { scopes: ['reminders'], enabled: item !== null });
  const existing = item ? reminders.data?.find((r) => r.targetType === 'open_item' && r.targetId === item.id) : undefined;
  return (
    <Dialog open={item !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="reminder-dialog">
        <DialogHeader>
          <DialogTitle>{existing ? 'Erinnerung verschieben' : 'Erinnerung setzen'}</DialogTitle>
          <DialogDescription>{item?.title}</DialogDescription>
        </DialogHeader>
        {existing && <p className="text-sm text-muted-foreground">Aktuell geplant für {formatDate(existing.remindAt)}.</p>}
        <QuickDate
          disabled={busy || !item}
          onPick={async (day) => {
            if (!item) return;
            const out = await run(
              () =>
                existing
                  ? call('reminders:snooze', { id: existing.id, remindAt: day })
                  : call('reminders:create', { targetType: 'open_item', targetId: item.id, title: item.title, remindAt: day }),
              { success: `Erinnerung für den ${formatDate(day)} gesetzt.` },
            );
            if (out) {
              onDone();
              onClose();
            }
          }}
        />
        {existing && (
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={async () => {
                const out = await run(() => call('reminders:dismiss', { id: existing.id }), { success: 'Erinnerung verworfen.' });
                if (out) {
                  onDone();
                  onClose();
                }
              }}
              data-testid="reminder-dialog-dismiss"
            >
              <X aria-hidden /> Erinnerung verwerfen
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
