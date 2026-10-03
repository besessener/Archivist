'use client';

import { formatNumber } from '@/lib/format';
import { useQuery } from '@/lib/use-query';

/** What is left of the daily token limit (from the usage API) next to the estimate of a bulk run, and what happens when it runs out. */
export function TokenBudgetNote({ estimatedTokens }: { estimatedTokens: number }) {
  const { data } = useQuery('llm:usage', {});
  if (!data) return null;
  const used = data.today.totalTokens;
  if (data.dailyCap === null)
    return (
      <p className="mt-1" data-testid="bulk-consent-budget">
        Es ist kein Tageslimit für Tokens gesetzt. Heute verbraucht: {formatNumber(used)} Token.
      </p>
    );
  const remaining = Math.max(0, data.dailyCap - used);
  if (data.capReached)
    return (
      <p className="mt-1 font-medium text-foreground" data-testid="bulk-consent-budget">
        Das Tageslimit von {formatNumber(data.dailyCap)} Token ist erreicht. Die Analyse startet, pausiert aber sofort und läuft morgen weiter – oder sobald du
        das Limit unter Einstellungen → Datenschutz erhöhst.
      </p>
    );
  return (
    <p className="mt-1" data-testid="bulk-consent-budget">
      Tageslimit: {formatNumber(data.dailyCap)} Token, heute noch {formatNumber(remaining)} übrig.
      {estimatedTokens > remaining
        ? ' Die Schätzung liegt darüber: Die Analyse pausiert, wenn das Limit erreicht ist, und läuft morgen weiter, ohne dass etwas verloren geht.'
        : ''}
    </p>
  );
}
