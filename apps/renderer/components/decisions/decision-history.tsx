'use client';

import Link from 'next/link';
import { EmptyState, ErrorNote, Loading } from '@/components/common/states';
import { auditActionLabel, auditChangeLines } from '@/lib/audit-labels';
import { formatDateTime } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import type { DecisionRecord } from '@/lib/types';

/** What happened to a decision since it was recorded: its replacement and every change from the audit log, with the values before and after. */
export function DecisionHistory({ decision }: { decision: DecisionRecord }) {
  const history = useQuery('audit:list', { entityId: decision.id, limit: 200 }, { scopes: ['audit', 'decisions'] });
  return (
    <div className="flex flex-col gap-3" data-testid="decision-history">
      <h3 className="text-sm font-semibold">Änderungen seit der Entscheidung</h3>
      {decision.supersededBy.length > 0 && (
        <p className="text-sm" data-testid="decision-superseded-by-note">
          Ersetzt durch{' '}
          {decision.supersededBy.map((successor, index) => (
            <span key={successor.id}>
              {index > 0 && ', '}
              <Link className="text-primary hover:underline" href={`/decisions/?id=${encodeURIComponent(successor.id)}`}>
                {successor.title}
              </Link>
            </span>
          ))}
        </p>
      )}
      {history.error && !history.data && <ErrorNote error={history.error} onRetry={() => void history.refetch()} />}
      {!history.data && history.loading && <Loading />}
      {history.data && history.data.length === 0 && <EmptyState title="Noch keine Änderungen festgehalten" />}
      {history.data && history.data.length > 0 && (
        <ol className="flex flex-col gap-2">
          {history.data.map((entry) => (
            <li key={entry.id} className="rounded-lg border bg-card p-3 text-sm" data-testid="decision-history-entry">
              <p className="font-medium">{auditActionLabel(entry.action)}</p>
              <p className="text-xs text-muted-foreground">
                {formatDateTime(entry.at)} · {entry.actor === 'user' ? 'Du' : 'Archivist'}
                {entry.undoneAt && ` · rückgängig gemacht am ${formatDateTime(entry.undoneAt)}`}
              </p>
              {auditChangeLines(entry).length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                  {auditChangeLines(entry).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
