'use client';

import type { BulkEstimate } from '@archivist/shared';
import { Notice } from '@/components/common/states';
import { TokenBudgetNote } from '@/components/common/token-budget-note';
import { CheckboxField } from '@/components/ui/checkbox';
import { formatNumber, plural } from '@/lib/format';
import { useSettings } from '@/lib/use-settings';

/** The one consent of a bulk run: what is sent, how much (a rough token estimate) and the checkbox for „vorher fragen“. */
export function BulkConsent({
  estimate,
  noun,
  checked,
  onCheckedChange,
  testId,
}: {
  estimate: BulkEstimate;
  noun: readonly [string, string];
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  testId: string;
}) {
  const { settings } = useSettings();
  const mode = settings?.privacy.llmMode ?? 'confirm';
  const masksPersonal = settings?.privacy.maskPersonalData ?? true;
  const rest = estimate.total - estimate.llmEligible;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p>
        <strong>Lokal</strong> liest Archivist die Texte nur auf diesem Computer. Dabei verlässt nichts deinen Rechner.
      </p>
      <Notice tone="warning" title="Was bei einer KI-Analyse gesendet wird" data-testid="bulk-consent-explain">
        <p>
          Der gespeicherte oder extrahierte <strong>Textinhalt</strong> (gekürzt;{' '}
          {masksPersonal
            ? 'erkannte Passwörter und Schlüssel sowie persönliche Daten wie IBAN, Kartennummern und Steuer-ID werden maskiert'
            : 'erkannte Passwörter und Schlüssel werden maskiert, persönliche Daten wie IBAN nicht'}
          ) sowie Dateiname und Typ werden an den eingerichteten KI-Dienst
          {settings?.llm.baseUrl ? (
            <>
              {' '}
              (<code className="break-all">{settings.llm.baseUrl}</code>)
            </>
          ) : (
            ''
          )}{' '}
          gesendet und im Übertragungsprotokoll festgehalten. Die Originaldateien selbst werden nicht hochgeladen.
        </p>
        <p className="mt-1" data-testid="bulk-consent-estimate">
          {formatNumber(estimate.llmEligible)} von {plural(estimate.total, noun)} dürfen laut deinen Einstellungen an die KI gesendet werden
          {rest > 0 ? `; die übrigen ${formatNumber(rest)} werden nur lokal verarbeitet.` : '.'} Geschätzt sind das etwa{' '}
          <strong>{formatNumber(estimate.estimatedTokens)} Token</strong> (grobe Schätzung, rund 4 Zeichen je Token).
        </p>
        <TokenBudgetNote estimatedTokens={estimate.estimatedTokens} />
        {mode === 'local_only' && (
          <p className="mt-1 font-medium text-foreground">Dein Datenschutzmodus ist „Nur lokal“ – es wird nichts an die KI gesendet.</p>
        )}
      </Notice>
      <CheckboxField
        checked={checked}
        disabled={mode === 'local_only'}
        onCheckedChange={(v) => onCheckedChange(v === true)}
        label="Ja, ich erlaube, dass diese Textinhalte an den KI-Dienst gesendet werden."
        data-testid={testId}
      />
    </div>
  );
}
