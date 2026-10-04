'use client';

import { Switch } from '@/components/ui/switch';
import { Section, SwitchRow, useSaveSettings, type TabProps } from './shared';

/** Switch for masking personal identifiers; says plainly what stays readable for the KI. */
export function MaskingSection({ settings, reload }: Pick<TabProps, 'settings' | 'reload'>) {
  const { save } = useSaveSettings(reload);
  return (
    <Section
      title="Persönliche Daten maskieren"
      description="Zugangsdaten und Schlüssel werden immer unkenntlich gemacht, bevor etwas an die KI geht. Zusätzlich kannst du persönliche Kennungen durch Platzhalter wie [IBAN] ersetzen lassen."
    >
      <SwitchRow
        label="IBAN, Kartennummern, Steuer-ID, Sozialversicherungsnummer und PINs maskieren"
        hint="Gilt für Anfragen an die KI, Embeddings, das Protokoll und die Vorschau unten."
      >
        <Switch
          checked={settings.privacy.maskPersonalData}
          onCheckedChange={(value) => void save({ privacy: { maskPersonalData: value } })}
          aria-label="Persönliche Daten maskieren"
          data-testid="privacy-mask-personal"
        />
      </SwitchRow>
      <p className="text-sm text-muted-foreground" data-testid="privacy-mask-note">
        Nicht maskiert werden Gesundheitsdaten, Namen, Adressen, Telefonnummern und E-Mail-Adressen. Sie gehen unverändert an die KI, sobald ein Dokument oder
        eine Nachricht gesendet werden darf. Was gar nicht gesendet werden soll, trägst du unter „Nie analysieren“ ein.
      </p>
    </Section>
  );
}
