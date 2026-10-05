'use client';

import { useState } from 'react';
import { Save } from 'lucide-react';
import type { TokenTotals } from '@archivist/shared';
import { ErrorNote, Field, Loading, Notice } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatCost, tokenBreakdown } from '@/components/agent/run-utils';
import { formatNumber } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import { Section, useSaveSettings, type TabProps } from './shared';

function Totals({ label, totals, testId }: { label: string; totals: TokenTotals; testId: string }) {
  const cost = formatCost(totals.costUsd);
  const tokens = `${formatNumber(totals.totalTokens)} Tokens`;
  return (
    <div className="rounded-lg border p-3" data-testid={testId}>
      <p className="text-sm font-medium">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{cost ?? tokens}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {cost ? `${tokens} · ` : ''}
        {tokenBreakdown(totals)} · {formatNumber(totals.requests)} Anfragen
      </p>
      {totals.unpricedTokens > 0 && (
        <p className="mt-1 text-xs text-muted-foreground" data-testid={`${testId}-unpriced`}>
          {cost ? `Ohne ${formatNumber(totals.unpricedTokens)} Tokens` : 'Kosten unbekannt'} von Modellen ohne bekannten Preis – eigene Preise trägst du unter
          Agent ein.
        </p>
      )}
    </div>
  );
}

/** Token use today and this month, and the optional daily limit (empty = no limit). */
export function UsageSection({ settings, reload }: Pick<TabProps, 'settings' | 'reload'>) {
  const usage = useQuery('llm:usage', {}, { scopes: ['audit', 'settings'] });
  const { save, busy } = useSaveSettings(reload);
  const [cap, setCap] = useState(settings.llm.dailyTokenCap === null ? '' : String(settings.llm.dailyTokenCap));
  const parsed = cap.trim() === '' ? null : Number(cap);
  const invalid = parsed !== null && (!Number.isInteger(parsed) || parsed < 1000);

  return (
    <Section
      title="Tokenverbrauch"
      description="So viele Tokens hat die KI laut Antwort des Dienstes verbraucht – auch Wiederholungen nach Fehlern. Der Tag beginnt um Mitternacht deiner Zeit."
    >
      {usage.error && !usage.data && <ErrorNote error={usage.error} onRetry={() => void usage.refetch()} />}
      {!usage.data && usage.loading && <Loading />}
      {usage.data && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Totals label="Heute" totals={usage.data.today} testId="usage-today" />
          <Totals label="Dieser Monat" totals={usage.data.month} testId="usage-month" />
        </div>
      )}
      {usage.data?.capReached && (
        <Notice tone="warning" data-testid="usage-cap-reached">
          Das Tageslimit ist erreicht: Hintergrundarbeit pausiert bis morgen oder bis du das Limit erhöhst, im Chat fragt Archivist vorher.
        </Notice>
      )}
      <Field
        label="Tageslimit (Tokens)"
        htmlFor="usage-cap"
        hint="Leer lassen für kein Limit. Mindestens 1.000. Bei Erreichen pausieren Analysen im Hintergrund, im Chat fragt Archivist vorher."
        error={invalid ? 'Bitte eine ganze Zahl ab 1.000 eingeben oder das Feld leeren.' : undefined}
      >
        <Input
          id="usage-cap"
          inputMode="numeric"
          value={cap}
          onChange={(e) => setCap(e.target.value)}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={invalid ? 'usage-cap-error' : undefined}
          data-testid="usage-cap"
        />
      </Field>
      <div>
        <Button
          disabled={busy || invalid}
          data-testid="usage-cap-save"
          onClick={() => void save({ llm: { dailyTokenCap: parsed } }, parsed === null ? 'Tageslimit entfernt.' : 'Tageslimit gespeichert.')}
        >
          <Save aria-hidden /> Limit speichern
        </Button>
      </div>
    </Section>
  );
}
