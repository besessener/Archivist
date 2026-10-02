'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { EntityType, KnowledgeCreateResult, RelationStatus } from '@archivist/shared';
import { Check, GitMerge, Plus, Search, X } from 'lucide-react';
import { ActionCard } from '@/components/common/action-card';
import { ConfidenceBadge } from '@/components/common/confidence';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EntityChip, EntityIcon } from '@/components/common/entity-chip';
import { EventFormDialog } from '@/components/events/event-form-dialog';
import { Page, PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorNote, Field, Loading } from '@/components/common/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { call } from '@/lib/ipc';
import { RELATION_STATUS_LABELS, RELATION_TYPE_LABELS } from '@/lib/labels';
import { ENTITY_TYPE_LABELS } from '@/lib/nav';
import { formatDate } from '@/lib/format';
import { useDebounced } from '@/lib/use-debounced';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import { useToast } from '@/lib/toast';
import type { ActionRecord } from '@/lib/types';
import { cn } from '@/lib/utils';

const TYPES: EntityType[] = ['topic', 'project', 'person', 'event', 'note', 'category', 'tag', 'document', 'decision', 'task', 'question'];
const CREATABLE = ['topic', 'project', 'person', 'event', 'note'] as const;
type Creatable = (typeof CREATABLE)[number];

function statusVariant(s: RelationStatus) {
  return s === 'confirmed' ? ('success' as const) : s === 'rejected' ? ('danger' as const) : s === 'outdated' ? ('secondary' as const) : ('warning' as const);
}

function KnowledgeInner() {
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get('id');
  const [type, setType] = useState<EntityType | ''>('');
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 300);
  const list = useQuery('knowledge:listEntities', { ...(type ? { type } : {}), ...(q ? { query: q } : {}), limit: 300 }, { scopes: ['knowledge'] });
  const [createOpen, setCreateOpen] = useState(false);
  const [createKey, setCreateKey] = useState(0);
  /** Initial title of the open event dialog; null = closed. */
  const [eventSeed, setEventSeed] = useState<string | null>(null);
  const { run } = useRun();
  const { toast } = useToast();

  const showResult = ({ entity, created }: KnowledgeCreateResult) => {
    const label = ENTITY_TYPE_LABELS[entity.type];
    if (created) toast({ variant: 'success', title: `${label} angelegt.` });
    else toast({ variant: 'info', title: `${label} „${entity.name}“ existiert bereits.`, description: 'Der vorhandene Eintrag wurde geöffnet.' });
    void list.refetch();
    router.push(`/knowledge/?id=${encodeURIComponent(entity.id)}`);
  };

  return (
    <Page wide>
      <PageHeader
        title="Wissen"
        description="Alles, was Archivist über Ihre Themen, Projekte und Personen weiß – und wie es zusammenhängt."
        actions={
          <Button
            onClick={() => {
              setCreateKey((k) => k + 1);
              setCreateOpen(true);
            }}
            data-testid="knowledge-create"
          >
            <Plus aria-hidden /> Neu anlegen
          </Button>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Im Wissen suchen …"
              aria-label="Wissen durchsuchen"
              className="pl-9"
              data-testid="knowledge-search"
            />
          </div>
          <Select value={type} onChange={(e) => setType(e.target.value as EntityType | '')} aria-label="Art filtern" data-testid="knowledge-type-filter">
            <option value="">Alle Arten</option>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {ENTITY_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
          {list.error && !list.data && <ErrorNote error={list.error} onRetry={() => void list.refetch()} />}
          {!list.data && list.loading && <Loading />}
          {list.data && list.data.length === 0 && (
            <EmptyState title="Nichts gefunden" description="Legen Sie ein Thema, Projekt oder eine Person an oder ändern Sie den Filter." />
          )}
          <ul className="flex max-h-[65vh] flex-col gap-1 overflow-y-auto" data-testid="knowledge-list">
            {(list.data ?? []).map((e) => (
              <li key={e.id}>
                <Link
                  href={`/knowledge/?id=${encodeURIComponent(e.id)}`}
                  data-testid="knowledge-item"
                  aria-current={e.id === id ? 'true' : undefined}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2.5 py-2 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring',
                    e.id === id && 'bg-accent',
                  )}
                >
                  <EntityIcon type={e.type} className="size-4 shrink-0 text-primary" />
                  <span className={cn('min-w-0 flex-1 truncate', e.duplicateOfId && 'text-muted-foreground line-through')}>{e.name}</span>
                  {e.duplicateOfId && (
                    <span className="text-xs text-muted-foreground" data-testid="knowledge-item-duplicate">
                      Duplikat
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">{e.relationCount}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div className="min-w-0">
          {id ? (
            <EntityView key={id} id={id} />
          ) : (
            <EmptyState
              title="Wählen Sie einen Eintrag"
              description="Klicken Sie links auf ein Thema, Projekt oder eine Person, um die Verknüpfungen zu sehen."
            />
          )}
        </div>
      </div>
      <CreateEntityDialog
        key={`c-${createKey}`}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onResult={showResult}
        onPickEvent={(title) => {
          setCreateOpen(false);
          setEventSeed(title);
        }}
      />
      <EventFormDialog
        key={`e-${eventSeed ?? ''}`}
        open={eventSeed !== null}
        onOpenChange={(o) => !o && setEventSeed(null)}
        initialTitle={eventSeed ?? ''}
        onSubmit={async (input) => {
          const r = await run(() => call('knowledge:createEntity', { type: 'event', ...input }));
          if (r) showResult(r);
          return r !== undefined;
        }}
      />
    </Page>
  );
}

function CreateEntityDialog({
  open,
  onOpenChange,
  onResult,
  onPickEvent,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onResult: (r: KnowledgeCreateResult) => void;
  onPickEvent: (title: string) => void;
}) {
  const [type, setType] = useState<Exclude<Creatable, 'event'>>('topic');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const { run, busy } = useRun();
  const label = ENTITY_TYPE_LABELS[type];
  const isNote = type === 'note';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Neu anlegen</DialogTitle>
          <DialogDescription>Legen Sie ein neues Thema, Projekt, eine Person, eine Notiz oder ein Ereignis (mit Datum) an.</DialogDescription>
        </DialogHeader>
        <Field label="Art" htmlFor="new-entity-type">
          <Select
            id="new-entity-type"
            value={type}
            onChange={(e) => {
              const next = e.target.value as Creatable;
              // Events need a date: hand over to the same dialog the timeline uses.
              if (next === 'event') onPickEvent(name.trim());
              else setType(next);
            }}
            data-testid="knowledge-new-type"
          >
            {CREATABLE.map((t) => (
              <option key={t} value={t}>
                {ENTITY_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={isNote ? 'Titel' : 'Name'} htmlFor="new-entity-name">
          <Input
            id="new-entity-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={isNote ? 'Titel der Notiz' : `Name des Eintrags (${label})`}
            data-testid="knowledge-new-name"
          />
        </Field>
        <Field label={isNote ? 'Inhalt (optional)' : 'Beschreibung (optional)'} htmlFor="new-entity-desc">
          <Textarea id="new-entity-desc" value={description} onChange={(e) => setDescription(e.target.value)} data-testid="knowledge-new-description" />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button
            disabled={busy || !name.trim()}
            data-testid="knowledge-new-save"
            onClick={async () => {
              const r = await run(() =>
                call('knowledge:createEntity', { type, name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) }),
              );
              if (r) {
                setName('');
                setDescription('');
                onOpenChange(false);
                onResult(r);
              }
            }}
          >
            Anlegen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EntityView({ id }: { id: string }) {
  const detail = useQuery('knowledge:getEntity', { id }, { scopes: ['knowledge'] });
  const isTopic = detail.data?.entity.type === 'topic';
  const docs = useQuery('documents:forTopic', { topicId: id }, { scopes: ['documents', 'knowledge'], enabled: isTopic });
  const { run } = useRun();
  const [pending, setPending] = useState<{ relationId: string; status: RelationStatus; label: string } | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeAction, setMergeAction] = useState<ActionRecord | null>(null);

  if (detail.error && !detail.data) return <ErrorNote error={detail.error} onRetry={() => void detail.refetch()} />;
  if (!detail.data) return <Loading />;
  const { entity, relations } = detail.data;
  const outgoing = relations.filter((r) => r.direction === 'out');
  const incoming = relations.filter((r) => r.direction === 'in');

  const renderRel = (r: (typeof relations)[number]) => (
    <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-lg border p-2.5" data-testid="relation-row" data-status={r.status}>
      <span className="text-xs text-muted-foreground">{RELATION_TYPE_LABELS[r.relationType]}</span>
      <EntityChip type={r.other.type} id={r.other.id} label={r.other.name} detail={r.other.description} />
      <Badge variant={statusVariant(r.status)}>{RELATION_STATUS_LABELS[r.status]}</Badge>
      <ConfidenceBadge value={r.confidence} />
      {r.status === 'proposed' && (
        <span className="ml-auto flex gap-1.5">
          <Button
            size="sm"
            variant="outline"
            data-testid="relation-confirm"
            onClick={() =>
              setPending({
                relationId: r.id,
                status: 'confirmed',
                label: `„${entity.name}“ ${RELATION_TYPE_LABELS[r.relationType]} „${r.other.name}“ bestätigen`,
              })
            }
          >
            <Check aria-hidden /> Bestätigen
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid="relation-reject"
            onClick={() => setPending({ relationId: r.id, status: 'rejected', label: `Verknüpfung zu „${r.other.name}“ ablehnen` })}
          >
            <X aria-hidden /> Ablehnen
          </Button>
        </span>
      )}
    </li>
  );

  return (
    <div className="flex flex-col gap-5" data-testid="entity-detail">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="info">
            <EntityIcon type={entity.type} className="size-3" /> {ENTITY_TYPE_LABELS[entity.type]}
          </Badge>
          {entity.duplicateOfId && (
            <Badge variant="outline" data-testid="entity-duplicate">
              verworfen (Duplikat)
            </Badge>
          )}
          <span className="text-xs text-muted-foreground">Aktualisiert {formatDate(entity.updatedAt)}</span>
        </div>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight">{entity.name}</h2>
        {entity.description && <p className="mt-2 whitespace-pre-wrap text-muted-foreground">{entity.description}</p>}
        {entity.roles.length > 0 && <p className="mt-2 text-sm text-muted-foreground">Rollen: {entity.roles.join(', ')}</p>}
        {entity.type === 'topic' && (
          <Button variant="outline" size="sm" className="mt-3" onClick={() => setMergeOpen(true)} data-testid="knowledge-merge">
            <GitMerge aria-hidden /> Mit anderem Thema zusammenführen vorschlagen
          </Button>
        )}
      </div>

      {mergeAction && (
        <div data-testid="merge-action">
          <h3 className="mb-2 text-sm font-semibold">Vorschlag</h3>
          <ActionCard action={mergeAction} onResolved={() => void detail.refetch()} />
        </div>
      )}

      <section>
        <h3 className="mb-2 text-sm font-semibold">Verknüpfungen von hier ({outgoing.length})</h3>
        {outgoing.length === 0 ? (
          <p className="text-sm text-muted-foreground">Keine ausgehenden Verknüpfungen.</p>
        ) : (
          <ul className="flex flex-col gap-2">{outgoing.map(renderRel)}</ul>
        )}
      </section>
      <section>
        <h3 className="mb-2 text-sm font-semibold">Verweise hierher ({incoming.length})</h3>
        {incoming.length === 0 ? (
          <p className="text-sm text-muted-foreground">Keine eingehenden Verknüpfungen.</p>
        ) : (
          <ul className="flex flex-col gap-2">{incoming.map(renderRel)}</ul>
        )}
      </section>

      {isTopic && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">Zugeordnete Dokumente</h3>
          {docs.loading && !docs.data && <Loading />}
          {docs.data && docs.data.length === 0 && <p className="text-sm text-muted-foreground">Diesem Thema sind noch keine Dokumente zugeordnet.</p>}
          <ul className="flex flex-col gap-1.5" data-testid="topic-documents">
            {(docs.data ?? []).map((d) => (
              <li key={d.id}>
                <EntityChip type="document" id={d.id} label={d.title} detail={d.summary} />
              </li>
            ))}
          </ul>
          <Button asChild variant="link" size="sm" className="mt-1 px-0">
            <Link href={`/documents/?topicId=${encodeURIComponent(id)}`}>Alle Dokumente zu diesem Thema ansehen</Link>
          </Button>
        </section>
      )}

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        title={pending?.status === 'confirmed' ? 'Verknüpfung bestätigen' : 'Verknüpfung ablehnen'}
        description={pending?.label}
        confirmLabel={pending?.status === 'confirmed' ? 'Bestätigen' : 'Ablehnen'}
        destructive={pending?.status === 'rejected'}
        onConfirm={async () => {
          if (!pending) return;
          const ok = await run(() => call('knowledge:resolveRelation', { relationId: pending.relationId, status: pending.status, confirmed: true }), {
            success: 'Gespeichert.',
          });
          if (ok) {
            setPending(null);
            void detail.refetch();
          }
        }}
      >
        <p className="text-sm text-muted-foreground">
          Bestätigte Verknüpfungen fließen in Antworten und Zusammenhänge ein, abgelehnte werden nicht mehr vorgeschlagen.
        </p>
      </ConfirmDialog>

      <MergeDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        sourceId={entity.id}
        sourceName={entity.name}
        onProposed={(a) => {
          setMergeAction(a);
          setMergeOpen(false);
        }}
      />
    </div>
  );
}

function MergeDialog({
  open,
  onOpenChange,
  sourceId,
  sourceName,
  onProposed,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  sourceId: string;
  sourceName: string;
  onProposed: (a: ActionRecord) => void;
}) {
  const topics = useQuery('knowledge:listEntities', { type: 'topic', limit: 1000 }, { enabled: open });
  const [target, setTarget] = useState('');
  const { run, busy } = useRun();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Themen zusammenführen vorschlagen</DialogTitle>
          <DialogDescription>
            „{sourceName}“ soll in ein anderes Thema aufgehen. Es wird nur ein Vorschlag erstellt – Sie bestätigen ihn anschließend.
          </DialogDescription>
        </DialogHeader>
        <Field label="Zusammenführen mit" htmlFor="merge-target">
          <Select id="merge-target" value={target} onChange={(e) => setTarget(e.target.value)} data-testid="merge-target">
            <option value="">Thema wählen …</option>
            {(topics.data ?? [])
              .filter((t) => t.id !== sourceId)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </Select>
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button
            disabled={!target || busy}
            data-testid="merge-propose"
            onClick={async () => {
              const a = await run(() => call('knowledge:proposeMerge', { sourceTopicId: sourceId, targetTopicId: target }));
              if (a) onProposed(a);
            }}
          >
            Vorschlag erstellen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function KnowledgePage() {
  return (
    <Suspense fallback={<Loading />}>
      <KnowledgeInner />
    </Suspense>
  );
}
