'use client';

import Link from 'next/link';
import { Notice } from '@/components/common/states';
import { useQuery } from '@/lib/use-query';

/** Open contradictions and „möglicherweise überholt“ hints of the archive check that concern this decision – a valid-looking status alone says nothing about them. */
export function DecisionHints({ id }: { id: string }) {
  // only what concerns this decision: a handful of rows, never the whole list
  const contradictions = useQuery('contradictions:list', { status: 'detected', entityId: id, limit: 50 }, { scopes: ['contradictions'] });
  const insights = useQuery('insights:list', { status: 'open', kind: 'possibly_superseded', entityId: id, limit: 50 }, { scopes: ['insights'] });
  const conflicts = (contradictions.data ?? []).filter((contradiction) => contradiction.affectedEntityIds.includes(id));
  const outdated = (insights.data ?? []).filter((insight) => insight.kind === 'possibly_superseded' && insight.affected[0]?.id === id);
  if (conflicts.length === 0 && outdated.length === 0) return null;
  return (
    <Notice tone="warning" title="Hinweise zu dieser Entscheidung" data-testid="decision-hints">
      <ul className="list-disc pl-5">
        {conflicts.map((conflict) => (
          <li key={conflict.id} data-testid="decision-hint-contradiction">
            <strong>Offener Widerspruch:</strong> {conflict.description.split('\n')[0]}{' '}
            {conflict.affectedEntityIds
              .filter((other) => other !== id)
              .map((other) => (
                <Link key={other} className="text-primary hover:underline" href={`/decisions/?id=${encodeURIComponent(other)}`}>
                  Andere Entscheidung ansehen
                </Link>
              ))}{' '}
            ·{' '}
            <Link className="text-primary hover:underline" href="/insights/">
              Auf der Seite Hinweise klären
            </Link>
          </li>
        ))}
        {outdated.map((insight) => (
          <li key={insight.id} data-testid="decision-hint-superseded">
            <strong>Möglicherweise überholt:</strong> Es gibt eine neuere Entscheidung zum selben Thema
            {insight.affected[1] && (
              <>
                {' '}
                –{' '}
                <Link className="text-primary hover:underline" href={`/decisions/?id=${encodeURIComponent(insight.affected[1].id)}`}>
                  {insight.affected[1].label}
                </Link>
              </>
            )}
            .{' '}
            <Link className="text-primary hover:underline" href="/insights/">
              Auf der Seite Hinweise klären
            </Link>
          </li>
        ))}
      </ul>
    </Notice>
  );
}
