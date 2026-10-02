'use client';

import { Plus, Trash2 } from 'lucide-react';
import type { AgentSettings } from '@archivist/shared';
import { Field } from '@/components/common/states';
import { Section, SwitchRow } from '@/components/settings/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { formatDateTime } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import { AgentCapabilityNote } from './capability-note';
import type { LimitsForm, PriceRow } from './settings-parse';

type Background = AgentSettings['background'];

const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

let rowCounter = 0;

export function priceRowsFrom(prices: AgentSettings['prices']): PriceRow[] {
  return Object.entries(prices).map(([model, price]) => ({
    key: ++rowCounter,
    model,
    input: String(price.input),
    output: String(price.output),
    cacheRead: String(price.cacheRead),
    cacheWrite: String(price.cacheWrite),
  }));
}

export function LimitsFields({ id, title, value, onChange }: { id: string; title: string; value: LimitsForm; onChange: (value: LimitsForm) => void }) {
  return (
    <fieldset className="rounded-lg border p-3">
      <legend className="px-1 text-sm font-medium">{title}</legend>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Runden (Notbremse)" htmlFor={`${id}-rounds`}>
          <Input id={`${id}-rounds`} type="number" min={1} max={1000} value={value.rounds} onChange={(e) => onChange({ ...value, rounds: e.target.value })} />
        </Field>
        <Field label="Tokens pro Lauf" htmlFor={`${id}-tokens`}>
          <Input
            id={`${id}-tokens`}
            type="number"
            min={5000}
            max={50000000}
            step={1000}
            value={value.tokens}
            onChange={(e) => onChange({ ...value, tokens: e.target.value })}
          />
        </Field>
        <Field label="Zeitlimit (Minuten)" htmlFor={`${id}-minutes`}>
          <Input
            id={`${id}-minutes`}
            type="number"
            min={1}
            max={1440}
            value={value.minutes}
            onChange={(e) => onChange({ ...value, minutes: e.target.value })}
          />
        </Field>
      </div>
    </fieldset>
  );
}

export function PriceTable({
  rows,
  onChange,
  defaultModel,
}: {
  rows: PriceRow[];
  onChange: (update: (rows: PriceRow[]) => PriceRow[]) => void;
  defaultModel: string;
}) {
  const setPrice = (index: number, change: Partial<PriceRow>) => onChange((current) => current.map((row, j) => (j === index ? { ...row, ...change } : row)));
  return (
    <fieldset className="rounded-lg border p-3">
      <legend className="px-1 text-sm font-medium">Eigene Preise (optional, US$ pro 1 Mio. Tokens)</legend>
      <p className="text-xs text-muted-foreground">Überschreiben die eingebaute Preistabelle – nur für die Anzeige des Verbrauchs.</p>
      {rows.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          {rows.map((row, i) => (
            <div key={row.key} className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[2fr_1fr_1fr_1fr_1fr_auto]">
              <Field label="Modell" htmlFor={`price-${i}-model`}>
                <Input id={`price-${i}-model`} value={row.model} onChange={(e) => setPrice(i, { model: e.target.value })} />
              </Field>
              <Field label="Eingabe" htmlFor={`price-${i}-in`}>
                <Input id={`price-${i}-in`} inputMode="decimal" value={row.input} onChange={(e) => setPrice(i, { input: e.target.value })} />
              </Field>
              <Field label="Ausgabe" htmlFor={`price-${i}-out`}>
                <Input id={`price-${i}-out`} inputMode="decimal" value={row.output} onChange={(e) => setPrice(i, { output: e.target.value })} />
              </Field>
              <Field label="Cache lesen" htmlFor={`price-${i}-cr`}>
                <Input id={`price-${i}-cr`} inputMode="decimal" value={row.cacheRead} onChange={(e) => setPrice(i, { cacheRead: e.target.value })} />
              </Field>
              <Field label="Cache schreiben" htmlFor={`price-${i}-cw`}>
                <Input id={`price-${i}-cw`} inputMode="decimal" value={row.cacheWrite} onChange={(e) => setPrice(i, { cacheWrite: e.target.value })} />
              </Field>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Preis für ${row.model || 'Modell'} entfernen`}
                onClick={() => onChange((current) => current.filter((_, j) => j !== i))}
              >
                <Trash2 aria-hidden />
              </Button>
            </div>
          ))}
        </div>
      )}
      <Button
        variant="outline"
        size="sm"
        className="mt-2"
        onClick={() => onChange((current) => [...current, { key: ++rowCounter, model: defaultModel, input: '', output: '', cacheRead: '', cacheWrite: '' }])}
      >
        <Plus aria-hidden /> Preis hinzufügen
      </Button>
    </fieldset>
  );
}

export function BackgroundSection({
  background,
  onChange,
  leadDays,
  onLeadDaysChange,
}: {
  background: Background;
  onChange: (background: Background) => void;
  leadDays: string;
  onLeadDaysChange: (leadDays: string) => void;
}) {
  return (
    <Section title="Hintergrund" description="Aufgaben, die Archivist ohne Chat erledigt. Ergebnisse erscheinen in der Glocke und unter „Agentenläufe“.">
      <SwitchRow label="Neue Dateien einsortieren" hint="Nach einer Suche oder einem Import.">
        <Switch checked={background.inbox} onCheckedChange={(checked) => onChange({ ...background, inbox: checked })} aria-label="Neue Dateien einsortieren" />
      </SwitchRow>
      <SwitchRow label="Archivprüfung auswerten" hint="Befunde bewerten und Aufräumarbeiten vorschlagen oder erledigen.">
        <Switch
          checked={background.archiveCheck}
          onCheckedChange={(checked) => onChange({ ...background, archiveCheck: checked })}
          aria-label="Archivprüfung auswerten"
        />
      </SwitchRow>
      <SwitchRow label="Verknüpfungen vorschlagen" hint="Für Einträge ohne Verbindung (nur Vorschläge).">
        <Switch checked={background.links} onCheckedChange={(checked) => onChange({ ...background, links: checked })} aria-label="Verknüpfungen vorschlagen" />
      </SwitchRow>
      <Field label="Nachtlauf (Archivprüfung und Verknüpfungen)" htmlFor="agent-nightly">
        <Select
          id="agent-nightly"
          value={background.nightlyHour === null ? '' : String(background.nightlyHour)}
          onChange={(e) => onChange({ ...background, nightlyHour: e.target.value === '' ? null : Number(e.target.value) })}
        >
          <option value="">aus</option>
          {Array.from({ length: 24 }, (_, hour) => (
            <option key={hour} value={hour}>
              um {String(hour).padStart(2, '0')}:00 Uhr
            </option>
          ))}
        </Select>
      </Field>
      <SwitchRow label="Fristen-Wächter" hint="Meldet anstehende Fristen, überfällige offene Punkte und Erinnerungen.">
        <Switch
          checked={background.deadlineWatch}
          onCheckedChange={(checked) => onChange({ ...background, deadlineWatch: checked })}
          aria-label="Fristen-Wächter"
        />
      </SwitchRow>
      {background.deadlineWatch && (
        <Field label="Vorlauf (Tage)" htmlFor="agent-lead">
          <Input id="agent-lead" type="number" min={1} max={365} className="w-32" value={leadDays} onChange={(e) => onLeadDaysChange(e.target.value)} />
        </Field>
      )}
      <SwitchRow label="Wochenrückblick" hint="In einer eigenen Unterhaltung.">
        <Switch
          checked={background.weeklyReview}
          onCheckedChange={(checked) => onChange({ ...background, weeklyReview: checked })}
          aria-label="Wochenrückblick"
        />
      </SwitchRow>
      {background.weeklyReview && (
        <Field label="Wochentag" htmlFor="agent-weekday">
          <Select
            id="agent-weekday"
            value={String(background.weeklyReviewDay)}
            onChange={(e) => onChange({ ...background, weeklyReviewDay: Number(e.target.value) })}
          >
            {WEEKDAYS.map((day, i) => (
              <option key={day} value={i}>
                {day}
              </option>
            ))}
          </Select>
        </Field>
      )}
    </Section>
  );
}

export function CapabilitySection({ onApply }: { onApply: (url: string) => void }) {
  const capability = useQuery('agent:capability', {}, { scopes: ['settings', 'agent'] });
  return (
    <Section title="Fähigkeiten der Verbindung" description="Ergebnis des letzten Verbindungstests (Einstellungen → KI → Verbindung testen).">
      {capability.data ? (
        <div className="text-sm" data-testid="agent-settings-capability">
          <AgentCapabilityNote capability={capability.data} onApplyBaseUrl={onApply} applyLabel="Übernehmen" testId="agent-settings-capability-note" />
          <p className="mt-1 text-xs text-muted-foreground">Geprüft am {formatDateTime(capability.data.checkedAt)}</p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Noch nicht geprüft. Teste die Verbindung unter „KI“.</p>
      )}
    </Section>
  );
}
