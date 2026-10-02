'use client';

import { BellPlus, Check, Link2, X } from 'lucide-react';
import type { InsightChoice, InsightKind } from '@archivist/shared';
import { ConfidenceBadge } from '@/components/common/confidence';
import { EntityChip } from '@/components/common/entity-chip';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/format';
import type { InsightRecord } from '@/lib/types';

/** Duplicate questions: confirming merges, rejecting remembers permanently that the entries are different. */
const DUPLICATE_KINDS = new Set<InsightKind>(['similar_entities']);
/** Reports of automatic changes: confirming undoes the change, rejecting keeps it. */
const UNDO_KINDS = new Set<InsightKind>(['persons_merged']);
const acceptLabel = (kind: InsightKind) => (DUPLICATE_KINDS.has(kind) ? 'Zusammenführen' : UNDO_KINDS.has(kind) ? 'Rückgängig' : 'Bestätigen');
const rejectLabel = (kind: InsightKind) => (DUPLICATE_KINDS.has(kind) ? 'Verschieden' : UNDO_KINDS.has(kind) ? 'Behalten' : 'Ablehnen');
export const rejectSuccess = (kind: InsightKind) =>
  DUPLICATE_KINDS.has(kind) ? 'Als verschieden gemerkt.' : UNDO_KINDS.has(kind) ? 'Zusammenführung behalten.' : 'Hinweis abgelehnt.';

export interface InsightActions {
  choose: (insight: InsightRecord, choice: InsightChoice) => void;
  accept: (insight: InsightRecord) => void;
  reject: (insight: InsightRecord) => Promise<void>;
  snooze: (insight: InsightRecord) => void;
}

export function InsightCard({ insight, busy, actions }: { insight: InsightRecord; busy: boolean; actions: InsightActions }) {
  return (
    <li className="rounded-xl border bg-card p-4" data-testid="insight-card" data-kind={insight.kind}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="font-semibold">{insight.title}</h3>
        <ConfidenceBadge value={insight.confidence} />
      </div>
      <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">{insight.explanation}</p>
      {insight.affected.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Betrifft:</span>
          {insight.affected.map((entry) => (
            <EntityChip key={`${entry.type}-${entry.id}`} type={entry.type} id={entry.id} label={entry.label} detail={entry.detail} />
          ))}
        </div>
      )}
      {insight.recommendedActionLabel && (
        <p className="mt-2 text-sm">
          <span className="font-medium">Empfehlung: </span>
          {insight.recommendedActionLabel}
        </p>
      )}
      {insight.chosenChoiceId && (
        <p className="mt-2 text-sm" data-testid="insight-chosen">
          <span className="font-medium">Antwort: </span>
          {insight.choices.find((choice) => choice.id === insight.chosenChoiceId)?.label ?? insight.chosenChoiceId}
        </p>
      )}
      {insight.status === 'snoozed' && insight.snoozedUntil && (
        <p className="mt-2 text-xs text-muted-foreground">Zurückgestellt bis {formatDate(insight.snoozedUntil)}</p>
      )}
      {insight.status === 'open' && <InsightButtons insight={insight} busy={busy} actions={actions} />}
    </li>
  );
}

/** A question insight shows its answers, a classic one „Bestätigen“; „Ablehnen“ unless an answer already means „nein“. */
function InsightButtons({ insight, busy, actions }: { insight: InsightRecord; busy: boolean; actions: InsightActions }) {
  return (
    <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={insight.choices.length > 0 ? 'Antworten' : 'Aktionen'}>
      {insight.choices.map((choice) => (
        <Button
          key={choice.id}
          size="sm"
          variant={choice.actionId ? 'default' : 'outline'}
          disabled={busy}
          title={choice.description ?? undefined}
          data-testid="insight-choice"
          data-choice-id={choice.id}
          onClick={() => actions.choose(insight, choice)}
        >
          {choice.label}
        </Button>
      ))}
      {insight.kind === 'orphan_entries' && (
        <Button
          size="sm"
          variant="outline"
          data-testid="insight-show-link-proposals"
          onClick={() => document.getElementById('link-proposals')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        >
          <Link2 aria-hidden /> Vorschläge prüfen
        </Button>
      )}
      {insight.choices.length === 0 && (
        <Button size="sm" onClick={() => actions.accept(insight)} data-testid="insight-accept">
          <Check aria-hidden /> {acceptLabel(insight.kind)}
        </Button>
      )}
      {!insight.choices.some((choice) => choice.actionId === null) && (
        <Button size="sm" variant="outline" disabled={busy} data-testid="insight-reject" onClick={() => actions.reject(insight)}>
          <X aria-hidden /> {rejectLabel(insight.kind)}
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={() => actions.snooze(insight)} data-testid="insight-snooze">
        <BellPlus aria-hidden /> Später erinnern
      </Button>
    </div>
  );
}
