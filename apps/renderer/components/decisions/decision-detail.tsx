'use client';

import { useState } from 'react';
import Link from 'next/link';
import { DECISION_FIELD_LABELS } from '@archivist/shared';
import { Pencil, Replace, Trash2 } from 'lucide-react';
import { ActionCard } from '@/components/common/action-card';
import { ConfidenceBadge } from '@/components/common/confidence';
import { Markdown } from '@/components/common/markdown';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { ErrorNote, Loading } from '@/components/common/states';
import { DecisionHints } from '@/components/decisions/decision-hints';
import { DecisionHistory } from '@/components/decisions/decision-history';
import { decisionStatusVariant } from '@/components/decisions/decision-list-item';
import { SupersedeDialog } from '@/components/decisions/supersede-dialog';
import { RelatedEntries } from '@/components/knowledge/related';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { call } from '@/lib/ipc';
import { DECISION_STATUS_HINTS, DECISION_STATUS_LABELS } from '@/lib/labels';
import { formatLongDate } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import type { ActionRecord, DecisionRecord } from '@/lib/types';

/** Where the decision was captured – a decision from a document is no dictated one (#175). */
const ORIGIN_LABELS: Record<NonNullable<DecisionRecord['origin']>, string> = {
  chat: 'Im Chat erfasst',
  form: 'Im Formular erfasst',
  document: 'Aus einem Dokument übernommen',
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 border-b py-2.5 last:border-0 sm:grid-cols-[10rem_1fr]">
      <dt className="text-sm font-medium text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

/** A required field: its value, „Bewusst unbekannt“ or a warning that it is missing. */
function RequiredValue({ known, unknown, children }: { known: boolean; unknown: boolean; children: React.ReactNode }) {
  if (known) return <>{children}</>;
  if (unknown) return <>Bewusst unbekannt</>;
  return <span className="text-warning">fehlt</span>;
}

const notGiven = <span className="text-muted-foreground">nicht angegeben</span>;

export function DecisionDetail({ id, onEdit, onDeleted }: { id: string; onEdit: (decision: DecisionRecord) => void; onDeleted: () => void }) {
  const detail = useQuery('decisions:get', { id }, { scopes: ['decisions'] });
  const [supersedeOpen, setSupersedeOpen] = useState(false);
  const [action, setAction] = useState<ActionRecord | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const { run } = useRun();
  if (detail.error && !detail.data) return <ErrorNote error={detail.error} onRetry={() => void detail.refetch()} />;
  if (!detail.data) return <Loading />;
  const decision = detail.data;
  return (
    <div className="flex flex-col gap-4" data-testid="decision-detail">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <Badge variant={decisionStatusVariant(decision.status)}>{DECISION_STATUS_LABELS[decision.status]}</Badge>
          <h2 className="mt-1.5 text-xl font-semibold tracking-tight">{decision.title || 'Entscheidung'}</h2>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => onEdit(decision)} data-testid="decision-edit">
            <Pencil aria-hidden /> Bearbeiten
          </Button>
          <Button size="sm" variant="outline" onClick={() => setSupersedeOpen(true)} data-testid="decision-supersede">
            <Replace aria-hidden /> Ersetzt durch …
          </Button>
          {(decision.status === 'draft' || decision.status === 'unclear') && (
            <Button size="sm" variant="outline" onClick={() => setDeleteOpen(true)} data-testid="decision-delete">
              <Trash2 aria-hidden /> Löschen
            </Button>
          )}
        </div>
      </div>
      <Tabs defaultValue="details">
        <TabsList aria-label="Ansichten der Entscheidung">
          <TabsTrigger value="details" data-testid="decision-tab-details">
            Details
          </TabsTrigger>
          <TabsTrigger value="history" data-testid="decision-tab-history">
            Verlauf
          </TabsTrigger>
        </TabsList>
        <TabsContent value="details" className="flex flex-col gap-4">
          {decision.missingFields.length > 0 && (
            <div className="rounded-lg border border-warning/60 bg-warning/10 p-3 text-sm" data-testid="decision-detail-missing">
              <p className="font-medium">Diese Entscheidung ist noch unvollständig</p>
              <p className="text-muted-foreground">Es fehlt: {decision.missingFields.map((field) => DECISION_FIELD_LABELS[field]).join(', ')}.</p>
            </div>
          )}
          <DecisionHints id={decision.id} />
          <DecisionFields decision={decision} />
          <RelatedEntries id={decision.id} link={{ name: decision.title }} scan />
          {action && (
            <div data-testid="supersede-action">
              <h3 className="mb-2 text-sm font-semibold">Vorschlag</h3>
              <ActionCard action={action} onResolved={() => void detail.refetch()} />
            </div>
          )}
        </TabsContent>
        <TabsContent value="history">
          <DecisionHistory decision={decision} />
        </TabsContent>
      </Tabs>
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Entscheidung löschen?"
        description={`„${decision.title}“ wird aus Entscheidungen, Suche und Wissensgraph entfernt. Rückgängig machen kannst du das unter Einstellungen → Änderungsprotokoll.`}
        confirmLabel="Löschen"
        confirmTestId="decision-delete-confirm"
        destructive
        onConfirm={async () => {
          const result = await run(() => call('decisions:delete', { id: decision.id, confirmed: true }), { success: 'Entscheidung gelöscht.' });
          setDeleteOpen(false);
          if (result) onDeleted();
        }}
      />
      <SupersedeDialog
        open={supersedeOpen}
        onOpenChange={setSupersedeOpen}
        oldId={decision.id}
        onProposed={(proposed) => {
          setAction(proposed);
          setSupersedeOpen(false);
        }}
      />
    </div>
  );
}

function DecisionFields({ decision }: { decision: DecisionRecord }) {
  return (
    <dl className="rounded-xl border bg-card shadow-card px-4">
      <Row label={DECISION_FIELD_LABELS.decidedAt}>
        <RequiredValue known={Boolean(decision.decidedAt)} unknown={decision.unknownFields.includes('decidedAt')}>
          {formatLongDate(decision.decidedAt)}
        </RequiredValue>
      </Row>
      <Row label={DECISION_FIELD_LABELS.topic}>
        <RequiredValue known={Boolean(decision.topicName)} unknown={decision.unknownFields.includes('topic')}>
          <Link className="text-primary hover:underline" href={`/knowledge/?id=${encodeURIComponent(decision.topicId ?? '')}`}>
            {decision.topicName}
          </Link>
        </RequiredValue>
        {decision.projectName && <span className="text-muted-foreground"> · Projekt {decision.projectName}</span>}
      </Row>
      <Row label={DECISION_FIELD_LABELS.participants}>
        <RequiredValue known={decision.participants.length > 0} unknown={decision.unknownFields.includes('participants')}>
          {decision.participants.join(', ')}
        </RequiredValue>
      </Row>
      <Row label={DECISION_FIELD_LABELS.decisionText}>
        <Markdown text={decision.decisionText} testId="decision-text-rendered" />
      </Row>
      <Row label="Begründung">{decision.rationale ?? notGiven}</Row>
      <Row label="Auswirkungen">{decision.consequences ? <Markdown text={decision.consequences} /> : notGiven}</Row>
      <Row label="Alternativen">
        {decision.alternatives.length > 0 ? (
          <ul className="list-disc pl-5">
            {decision.alternatives.map((alternative, i) => (
              <li key={`${i}-${alternative}`}>{alternative}</li>
            ))}
          </ul>
        ) : (
          notGiven
        )}
      </Row>
      <Row label="Gültigkeit">
        {decision.validFrom || decision.validUntil ? (
          `${decision.validFrom ? `ab ${formatLongDate(decision.validFrom)}` : ''} ${decision.validUntil ? `bis ${formatLongDate(decision.validUntil)}` : ''}`
        ) : (
          <span className="text-muted-foreground">unbefristet</span>
        )}
      </Row>
      <Row label="Status">
        {DECISION_STATUS_LABELS[decision.status]}
        <span className="text-muted-foreground"> – {DECISION_STATUS_HINTS[decision.status]}</span>
        {decision.supersededBy.map((successor) => (
          <span key={successor.id} className="text-muted-foreground" data-testid="decision-successor">
            {' '}
            · ersetzt durch{' '}
            <Link className="text-primary hover:underline" href={`/decisions/?id=${encodeURIComponent(successor.id)}`}>
              {successor.title}
            </Link>
          </span>
        ))}
        {decision.supersedesDecisionId && (
          <span className="text-muted-foreground">
            {' '}
            · ersetzt{' '}
            <Link className="text-primary hover:underline" href={`/decisions/?id=${encodeURIComponent(decision.supersedesDecisionId)}`}>
              eine frühere Entscheidung
            </Link>
          </span>
        )}
      </Row>
      <Row label="Herkunft">{decision.origin ? ORIGIN_LABELS[decision.origin] : <span className="text-muted-foreground">nicht erfasst</span>}</Row>
      {decision.evidence && (
        <Row label="Beleg">
          <blockquote className="border-l-2 border-primary/50 pl-2 text-muted-foreground italic" data-testid="decision-evidence">
            „{decision.evidence}“
          </blockquote>
        </Row>
      )}
      <Row label="Quellen">
        {decision.sourceIds.length > 0 ? (
          <span className="flex flex-wrap gap-1.5">
            {decision.sourceIds.map((sourceId, i) => (
              <SourceDocument key={sourceId} id={sourceId} index={i} />
            ))}
          </span>
        ) : (
          <span className="text-muted-foreground">keine</span>
        )}
      </Row>
      <Row label="Einschätzung">
        <ConfidenceBadge value={decision.confidence} label="Erfassung" />
      </Row>
    </dl>
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
