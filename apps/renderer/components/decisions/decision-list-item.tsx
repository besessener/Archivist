'use client';

import Link from 'next/link';
import { DECISION_FIELD_LABELS, type DecisionStatus, type EntrySubjects, type IpcOutput } from '@archivist/shared';
import { TriangleAlert } from 'lucide-react';
import { ExtraSubjectsNote } from '@/components/common/extra-subjects';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { DECISION_STATUS_LABELS } from '@/lib/labels';
import { formatLongDate } from '@/lib/format';
import { cn } from '@/lib/utils';

type ListedDecision = IpcOutput<'decisions:list'>[number];

export function decisionStatusVariant(status: DecisionStatus) {
  switch (status) {
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

const STRIPES: Partial<Record<DecisionStatus, 'danger' | 'warning'>> = { draft: 'warning', revoked: 'danger' };

export function DecisionListItem({
  decision,
  current,
  selected,
  onSelect,
  subjects,
}: {
  decision: ListedDecision;
  current: boolean;
  selected: boolean;
  onSelect: (selected: boolean) => void;
  subjects: EntrySubjects | undefined;
}) {
  return (
    <li className="flex items-start gap-2">
      <Checkbox
        className="mt-3.5"
        checked={selected}
        onCheckedChange={(checked) => onSelect(checked === true)}
        aria-label={`${decision.title || decision.decisionText} auswählen`}
        data-testid="decision-select"
      />
      <Link
        href={`/decisions/?id=${encodeURIComponent(decision.id)}`}
        data-testid="decision-row"
        data-status={decision.status}
        data-stripe={STRIPES[decision.status]}
        className={cn(
          'block min-w-0 flex-1 rounded-lg border bg-card p-3 shadow-card transition-colors hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring',
          current && 'ring-2 ring-primary/50',
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <p className="line-clamp-2 text-sm font-medium">{decision.title || decision.decisionText}</p>
          <Badge variant={decisionStatusVariant(decision.status)}>{DECISION_STATUS_LABELS[decision.status]}</Badge>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {formatLongDate(decision.decidedAt, 'Datum unbekannt')}
          {decision.topicName ? ` · ${decision.topicName}` : ''} <ExtraSubjectsNote subjects={subjects} />
        </p>
        {decision.missingFields.length > 0 && (
          <p className="mt-1.5 flex items-center gap-1 text-xs text-warning">
            <TriangleAlert className="size-3.5" aria-hidden /> Es fehlt: {decision.missingFields.map((field) => DECISION_FIELD_LABELS[field]).join(', ')}
          </p>
        )}
      </Link>
    </li>
  );
}
