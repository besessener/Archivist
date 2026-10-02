'use client';

import { ExtraSubjectsNote, useSubjectsOf } from '@/components/common/extra-subjects';
import { BulkAssignBar, useSelection } from '@/components/common/bulk-assign';
import { Checkbox } from '@/components/ui/checkbox';
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { DECISION_FIELD_LABELS, type DecisionStatus } from '@archivist/shared';
import { Pencil, Plus, Replace, Search, TriangleAlert } from 'lucide-react';
import { ActionCard } from '@/components/common/action-card';
import { ConfidenceBadge } from '@/components/common/confidence';
import { DecisionFormDialog } from '@/components/decisions/decision-form';
import { Markdown } from '@/components/common/markdown';
import { Page, PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorNote, Field, Loading } from '@/components/common/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { call } from '@/lib/ipc';
import { DECISION_STATUS_LABELS } from '@/lib/labels';
import { formatLongDate } from '@/lib/format';
import { useDebounced } from '@/lib/use-debounced';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import type { ActionRecord, DecisionRecord } from '@/lib/types';
import { cn } from '@/lib/utils';
import { RelatedEntries } from '@/components/knowledge/related';

/** Where the decision was captured – a decision from a document is no dictated one (#175). */
const ORIGIN_LABELS: Record<NonNullable<DecisionRecord['origin']>, string> = {
  chat: 'Im Chat erfasst',
  form: 'Im Formular erfasst',
  document: 'Aus einem Dokument übernommen',
};

function statusVariant(s: DecisionStatus) {
  switch (s) {
    case 'active':
    case 'confirmed':
      return 'success' as const;
    case 'draft':
      return 'warning' as const;
    case 'revoked':
      return 'danger' as const;
    default:
      return 'secondary' as const;
  }
}

function DecisionsInner() {
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get('id');
  const [status, setStatus] = useState<DecisionStatus | ''>('');
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 300);
  const byFilter = useQuery('decisions:list', { ...(status ? { status } : {}) }, { scopes: ['decisions'], enabled: !q });
  const bySearch = useQuery('decisions:search', { query: q || 'x', limit: 50 }, { scopes: ['decisions'], enabled: !!q });
  const active = q ? bySearch : byFilter;
  const decisions = (active.data ?? []).filter((d) => !q || !status || d.status === status);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<DecisionRecord | null>(null);

  const sorted = [...decisions].sort((a, b) => {
    if ((a.status === 'draft') !== (b.status === 'draft')) return a.status === 'draft' ? -1 : 1;
    return (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt);
  });
  const subjects = useSubjectsOf(sorted.map((d) => d.id));
  const selection = useSelection();

  return (
    <Page wide>
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
      <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
        <div className="flex min-w-0 flex-col gap-3">
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
            {(Object.keys(DECISION_STATUS_LABELS) as DecisionStatus[]).map((s) => (
              <option key={s} value={s}>
                {DECISION_STATUS_LABELS[s]}
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
          <ul className="flex max-h-[68vh] flex-col gap-2 overflow-y-auto" data-testid="decision-list">
            {sorted.map((d) => (
              <li key={d.id} className="flex items-start gap-2">
                <Checkbox
                  className="mt-3.5"
                  checked={selection.has(d.id)}
                  onCheckedChange={(v) => selection.toggle(d.id, v === true)}
                  aria-label={`${d.title || d.decisionText} auswählen`}
                  data-testid="decision-select"
                />
                <Link
                  href={`/decisions/?id=${encodeURIComponent(d.id)}`}
                  data-testid="decision-row"
                  data-status={d.status}
                  className={cn(
                    'block min-w-0 flex-1 rounded-lg border p-3 transition-colors hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring',
                    d.status === 'draft' && 'border-warning/60 bg-warning/8',
                    d.id === id && 'ring-2 ring-primary/50',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="line-clamp-2 text-sm font-medium">{d.title || d.decisionText}</p>
                    <Badge variant={statusVariant(d.status)}>{DECISION_STATUS_LABELS[d.status]}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatLongDate(d.decidedAt, 'Datum unbekannt')}
                    {d.topicName ? ` · ${d.topicName}` : ''} <ExtraSubjectsNote subjects={subjects[d.id]} />
                  </p>
                  {d.missingFields.length > 0 && (
                    <p className="mt-1.5 flex items-center gap-1 text-xs text-warning">
                      <TriangleAlert className="size-3.5" aria-hidden /> Es fehlt: {d.missingFields.map((f) => DECISION_FIELD_LABELS[f]).join(', ')}
                    </p>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div className="min-w-0">
          {id ? (
            <DecisionDetail
              key={id}
              id={id}
              onEdit={(d) => {
                setEditing(d);
                setFormOpen(true);
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
          onSaved={(d) => {
            void active.refetch();
            router.push(`/decisions/?id=${encodeURIComponent(d.id)}`);
          }}
        />
      )}
    </Page>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 border-b py-2.5 last:border-0 sm:grid-cols-[10rem_1fr]">
      <dt className="text-sm font-medium text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function DecisionDetail({ id, onEdit }: { id: string; onEdit: (d: DecisionRecord) => void }) {
  const detail = useQuery('decisions:get', { id }, { scopes: ['decisions'] });
  const [supOpen, setSupOpen] = useState(false);
  const [action, setAction] = useState<ActionRecord | null>(null);
  if (detail.error && !detail.data) return <ErrorNote error={detail.error} onRetry={() => void detail.refetch()} />;
  if (!detail.data) return <Loading />;
  const d = detail.data;
  return (
    <div className="flex flex-col gap-4" data-testid="decision-detail">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <Badge variant={statusVariant(d.status)}>{DECISION_STATUS_LABELS[d.status]}</Badge>
          <h2 className="mt-1.5 text-xl font-semibold tracking-tight">{d.title || 'Entscheidung'}</h2>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => onEdit(d)} data-testid="decision-edit">
            <Pencil aria-hidden /> Bearbeiten
          </Button>
          <Button size="sm" variant="outline" onClick={() => setSupOpen(true)} data-testid="decision-supersede">
            <Replace aria-hidden /> Ersetzt durch …
          </Button>
        </div>
      </div>
      {d.missingFields.length > 0 && (
        <div className="rounded-lg border border-warning/60 bg-warning/10 p-3 text-sm" data-testid="decision-detail-missing">
          <p className="font-medium">Diese Entscheidung ist noch unvollständig</p>
          <p className="text-muted-foreground">Es fehlt: {d.missingFields.map((f) => DECISION_FIELD_LABELS[f]).join(', ')}.</p>
        </div>
      )}
      <dl className="rounded-xl border bg-card px-4">
        <Row label={DECISION_FIELD_LABELS.decidedAt}>
          {d.decidedAt ? (
            formatLongDate(d.decidedAt)
          ) : d.unknownFields.includes('decidedAt') ? (
            'Bewusst unbekannt'
          ) : (
            <span className="text-warning">fehlt</span>
          )}
        </Row>
        <Row label={DECISION_FIELD_LABELS.topic}>
          {d.topicName ? (
            <Link className="text-primary hover:underline" href={`/knowledge/?id=${encodeURIComponent(d.topicId ?? '')}`}>
              {d.topicName}
            </Link>
          ) : d.unknownFields.includes('topic') ? (
            'Bewusst unbekannt'
          ) : (
            <span className="text-warning">fehlt</span>
          )}
          {d.projectName && <span className="text-muted-foreground"> · Projekt {d.projectName}</span>}
        </Row>
        <Row label={DECISION_FIELD_LABELS.participants}>
          {d.participants.length > 0 ? (
            d.participants.join(', ')
          ) : d.unknownFields.includes('participants') ? (
            'Bewusst unbekannt'
          ) : (
            <span className="text-warning">fehlt</span>
          )}
        </Row>
        <Row label={DECISION_FIELD_LABELS.decisionText}>
          <Markdown text={d.decisionText} testId="decision-text-rendered" />
        </Row>
        <Row label="Begründung">{d.rationale ?? <span className="text-muted-foreground">nicht angegeben</span>}</Row>
        <Row label="Auswirkungen">{d.consequences ? <Markdown text={d.consequences} /> : <span className="text-muted-foreground">nicht angegeben</span>}</Row>
        <Row label="Alternativen">
          {d.alternatives.length > 0 ? (
            <ul className="list-disc pl-5">
              {d.alternatives.map((a, i) => (
                <li key={`${i}-${a}`}>{a}</li>
              ))}
            </ul>
          ) : (
            <span className="text-muted-foreground">nicht angegeben</span>
          )}
        </Row>
        <Row label="Gültigkeit">
          {d.validFrom || d.validUntil ? (
            `${d.validFrom ? `ab ${formatLongDate(d.validFrom)}` : ''} ${d.validUntil ? `bis ${formatLongDate(d.validUntil)}` : ''}`
          ) : (
            <span className="text-muted-foreground">unbefristet</span>
          )}
        </Row>
        <Row label="Status">
          {DECISION_STATUS_LABELS[d.status]}
          {d.supersedesDecisionId && (
            <span className="text-muted-foreground">
              {' '}
              · ersetzt{' '}
              <Link className="text-primary hover:underline" href={`/decisions/?id=${encodeURIComponent(d.supersedesDecisionId)}`}>
                eine frühere Entscheidung
              </Link>
            </span>
          )}
        </Row>
        <Row label="Herkunft">{d.origin ? ORIGIN_LABELS[d.origin] : <span className="text-muted-foreground">nicht erfasst</span>}</Row>
        {d.evidence && (
          <Row label="Beleg">
            <blockquote className="border-l-2 border-primary/50 pl-2 text-muted-foreground italic" data-testid="decision-evidence">
              „{d.evidence}“
            </blockquote>
          </Row>
        )}
        <Row label="Quellen">
          {d.sourceIds.length > 0 ? (
            <span className="flex flex-wrap gap-1.5">
              {d.sourceIds.map((s, i) => (
                <SourceDocument key={s} id={s} index={i} />
              ))}
            </span>
          ) : (
            <span className="text-muted-foreground">keine</span>
          )}
        </Row>
        <Row label="Einschätzung">
          <ConfidenceBadge value={d.confidence} label="Erfassung" />
        </Row>
      </dl>
      <RelatedEntries id={d.id} link={{ name: d.title }} />
      {action && (
        <div data-testid="supersede-action">
          <h3 className="mb-2 text-sm font-semibold">Vorschlag</h3>
          <ActionCard action={action} onResolved={() => void detail.refetch()} />
        </div>
      )}
      <SupersedeDialog
        open={supOpen}
        onOpenChange={setSupOpen}
        oldId={d.id}
        onProposed={(a) => {
          setAction(a);
          setSupOpen(false);
        }}
      />
    </div>
  );
}

function SupersedeDialog({
  open,
  onOpenChange,
  oldId,
  onProposed,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  oldId: string;
  onProposed: (a: ActionRecord) => void;
}) {
  const all = useQuery('decisions:list', {}, { enabled: open });
  const [target, setTarget] = useState('');
  const { run, busy } = useRun();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Wodurch wird diese Entscheidung ersetzt?</DialogTitle>
          <DialogDescription>Wähle die neuere Entscheidung. Es wird ein Vorschlag erstellt, den du anschließend bestätigst.</DialogDescription>
        </DialogHeader>
        <Field label="Neuere Entscheidung" htmlFor="sup-target">
          <Select id="sup-target" value={target} onChange={(e) => setTarget(e.target.value)} data-testid="supersede-target">
            <option value="">Entscheidung wählen …</option>
            {(all.data ?? [])
              .filter((x) => x.id !== oldId)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {(x.title || x.decisionText).slice(0, 80)} ({formatLongDate(x.decidedAt, 'ohne Datum')})
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
            data-testid="supersede-propose"
            onClick={async () => {
              const a = await run(() => call('decisions:proposeSupersede', { oldDecisionId: oldId, newDecisionId: target }));
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

export default function DecisionsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <DecisionsInner />
    </Suspense>
  );
}

/** A source document of a decision, named by its title (#165); a removed document stays recognisable as such. */
function SourceDocument({ id, index }: { id: string; index: number }) {
  const doc = useQuery('documents:get', { id }, { scopes: ['documents'] });
  if (doc.error)
    return <span className="rounded-md border border-dashed px-2 py-0.5 text-xs text-muted-foreground">Quelle {index + 1} (nicht mehr vorhanden)</span>;
  return (
    <Link
      href={`/documents/?id=${encodeURIComponent(id)}`}
      className="rounded-md border px-2 py-0.5 text-xs hover:bg-accent"
      data-testid="decision-source"
      title={doc.data?.originalName ?? undefined}
    >
      {doc.data?.title ?? `Quelle ${index + 1}`}
    </Link>
  );
}
