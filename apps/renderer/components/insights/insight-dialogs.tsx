'use client';

import type { InsightChoice } from '@archivist/shared';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { QuickDate } from '@/components/common/quick-date';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { InsightRecord } from '@/lib/types';

const REVIEWED = 'Ich habe die betroffenen Objekte geprüft und möchte diese Aktion ausführen.';

export type PendingChoice = { insight: InsightRecord; choice: InsightChoice };

export function AcceptDialog({
  insight,
  onClose,
  onConfirm,
}: {
  insight: InsightRecord | null;
  onClose: () => void;
  onConfirm: (insight: InsightRecord, strongConfirmed: boolean) => Promise<void>;
}) {
  return (
    <ConfirmDialog
      open={insight !== null}
      onOpenChange={(open) => !open && onClose()}
      title="Empfehlung ausführen?"
      description={insight?.recommendedActionLabel ?? insight?.title}
      confirmLabel="Bestätigen und ausführen"
      requireCheckbox={REVIEWED}
      confirmTestId="insight-accept-confirm"
      onConfirm={async (checked) => {
        if (insight) await onConfirm(insight, checked);
      }}
    >
      {insight && (
        <div className="flex flex-col gap-2 text-sm">
          <p className="whitespace-pre-line text-muted-foreground">{insight.explanation}</p>
          {insight.affected.length > 0 && (
            <ul className="list-disc pl-5">
              {insight.affected.map((entry) => (
                <li key={`${entry.type}-${entry.id}`}>{entry.label}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </ConfirmDialog>
  );
}

export function ChoiceDialog({
  pending,
  onClose,
  onConfirm,
}: {
  pending: PendingChoice | null;
  onClose: () => void;
  onConfirm: (pending: PendingChoice, strongConfirmed: boolean) => Promise<void>;
}) {
  return (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(open) => !open && onClose()}
      title={pending ? `Antwort „${pending.choice.label}“ übernehmen?` : ''}
      description={pending?.insight.title}
      confirmLabel="Übernehmen"
      requireCheckbox={REVIEWED}
      confirmTestId="insight-choice-confirm"
      onConfirm={async (checked) => {
        if (pending) await onConfirm(pending, checked);
      }}
    >
      {pending && (
        <div className="flex flex-col gap-2 text-sm">
          {pending.choice.description && <p>{pending.choice.description}</p>}
          {pending.insight.affected.length > 0 && (
            <ul className="list-disc pl-5">
              {pending.insight.affected.map((entry) => (
                <li key={`${entry.type}-${entry.id}`}>
                  {entry.label}
                  {entry.detail ? ` (${entry.detail})` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </ConfirmDialog>
  );
}

export function SnoozeDialog({
  insight,
  busy,
  onClose,
  onPick,
}: {
  insight: InsightRecord | null;
  busy: boolean;
  onClose: () => void;
  onPick: (insight: InsightRecord, day: string) => Promise<void>;
}) {
  return (
    <Dialog open={insight !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="snooze-dialog">
        <DialogHeader>
          <DialogTitle>Später erinnern</DialogTitle>
          <DialogDescription>{insight?.title}</DialogDescription>
        </DialogHeader>
        <QuickDate
          disabled={busy}
          onPick={async (day) => {
            if (insight) await onPick(insight, day);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
