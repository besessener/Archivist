'use client';

import { useState } from 'react';
import { Plus, Save, Trash2 } from 'lucide-react';
import type { AgentSettings, SettingsPatch } from '@archivist/shared';
import { Field, Notice } from '@/components/common/states';
import { Section, SwitchRow, useSaveSettings, type TabProps } from '@/components/settings/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { formatDateTime } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import { AgentCapabilityNote } from './capability-note';

type AgentPatch = NonNullable<SettingsPatch['agent']>;

const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const EFFORTS: Array<[AgentSettings['effort'], string]> = [
  ['low', 'niedrig'],
  ['medium', 'mittel'],
  ['high', 'hoch'],
  ['xhigh', 'sehr hoch'],
  ['max', 'maximal'],
];

interface LimitsForm {
  rounds: string;
  tokens: string;
  minutes: string;
}
type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

let rowCounter = 0;
interface PriceRow {
  key: number;
  model: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
}

const toLimits = (l: AgentSettings['chatLimits']): LimitsForm => ({
  rounds: String(l.maxRounds),
  tokens: String(l.maxTokens),
  minutes: String(Math.round((l.timeoutMs / 60_000) * 10) / 10),
});

function intIn(value: string, min: number, max: number): number | null {
  const n = Number(value.replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  return r >= min && r <= max ? r : null;
}
function numIn(value: string, min: number): number | null {
  if (value.trim() === '') return 0;
  const n = Number(value.replace(',', '.'));
  return Number.isFinite(n) && n >= min ? n : null;
}

function parseLimits(f: LimitsForm, what: string): Parsed<NonNullable<AgentPatch['chatLimits']>> {
  const maxRounds = intIn(f.rounds, 1, 1000);
  const maxTokens = intIn(f.tokens, 5_000, 50_000_000);
  const minutes = Number(f.minutes.replace(',', '.'));
  if (maxRounds === null) return fail(`${what}: Runden zwischen 1 und 1000.`);
  if (maxTokens === null) return fail(`${what}: Tokens zwischen 5.000 und 50.000.000.`);
  if (!Number.isFinite(minutes) || minutes < 1 / 6 || minutes > 1440) return fail(`${what}: Zeitlimit zwischen 1 und 1440 Minuten.`);
  return { ok: true, value: { maxRounds, maxTokens, timeoutMs: Math.round(minutes * 60_000) } };
}

function LimitsFields({ id, title, value, onChange }: { id: string; title: string; value: LimitsForm; onChange: (v: LimitsForm) => void }) {
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

function CapabilitySection({ onApply }: { onApply: (url: string) => void }) {
  const cap = useQuery('agent:capability', {}, { scopes: ['settings', 'agent'] });
  return (
    <Section title="Fähigkeiten der Verbindung" description="Ergebnis des letzten Verbindungstests (Einstellungen → KI → Verbindung testen).">
      {cap.data ? (
        <div className="text-sm" data-testid="agent-settings-capability">
          <AgentCapabilityNote capability={cap.data} onApplyBaseUrl={onApply} applyLabel="Übernehmen" testId="agent-settings-capability-note" />
          <p className="mt-1 text-xs text-muted-foreground">Geprüft am {formatDateTime(cap.data.checkedAt)}</p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Noch nicht geprüft. Teste die Verbindung unter „KI“.</p>
      )}
    </Section>
  );
}

/** Settings of the agent mode (#294, #298, #313, #315). */
export function AgentSettingsForm({ settings, reload }: TabProps) {
  const a = settings.agent;
  const { save, busy } = useSaveSettings(reload);
  const [enabled, setEnabled] = useState(a.enabled);
  const [mode, setMode] = useState(a.mode);
  const [threshold, setThreshold] = useState(String(a.massActionThreshold));
  const [effort, setEffort] = useState(a.effort);
  const [adapter, setAdapter] = useState(a.adapter);
  const [chat, setChat] = useState(toLimits(a.chatLimits));
  const [bgLimits, setBgLimits] = useState(toLimits(a.backgroundLimits));
  const [retries, setRetries] = useState(String(a.maxRetries));
  const [learning, setLearning] = useState(a.learning);
  const [webSearch, setWebSearch] = useState(a.webSearch);
  const [bg, setBg] = useState(a.background);
  const [leadDays, setLeadDays] = useState(String(a.background.deadlineLeadDays));
  const [prices, setPrices] = useState<PriceRow[]>(() =>
    Object.entries(a.prices).map(([model, p]) => ({
      key: ++rowCounter,
      model,
      input: String(p.input),
      output: String(p.output),
      cacheRead: String(p.cacheRead),
      cacheWrite: String(p.cacheWrite),
    })),
  );

  function build(): Parsed<AgentPatch> {
    const massActionThreshold = intIn(threshold, 1, 100_000);
    if (massActionThreshold === null) return fail('Massenaktionen: Schwelle zwischen 1 und 100.000.');
    const maxRetries = intIn(retries, 0, 10);
    if (maxRetries === null) return fail('Wiederholungen: 0 bis 10.');
    const chatLimits = parseLimits(chat, 'Chat');
    if (!chatLimits.ok) return chatLimits;
    const backgroundLimits = parseLimits(bgLimits, 'Hintergrund');
    if (!backgroundLimits.ok) return backgroundLimits;
    const deadlineLeadDays = intIn(leadDays, 1, 365);
    if (deadlineLeadDays === null) return fail('Fristen-Wächter: Vorlauf zwischen 1 und 365 Tagen.');
    const priceTable: NonNullable<AgentPatch['prices']> = {};
    for (const row of prices) {
      const model = row.model.trim();
      if (!model) continue;
      const [input, output, cacheRead, cacheWrite] = [numIn(row.input, 0), numIn(row.output, 0), numIn(row.cacheRead, 0), numIn(row.cacheWrite, 0)];
      if (input === null || output === null || cacheRead === null || cacheWrite === null) return fail(`Preise für „${model}“: nur Zahlen ab 0.`);
      priceTable[model] = { input, output, cacheRead, cacheWrite };
    }
    return {
      ok: true,
      value: {
        enabled,
        mode,
        massActionThreshold,
        effort,
        adapter,
        chatLimits: chatLimits.value,
        backgroundLimits: backgroundLimits.value,
        maxRetries,
        learning,
        webSearch,
        prices: priceTable,
        background: { ...bg, deadlineLeadDays },
      },
    };
  }

  const patch = build();
  const error = patch.ok ? null : patch.error;
  const setPrice = (i: number, p: Partial<PriceRow>) => setPrices((rows) => rows.map((r, j) => (j === i ? { ...r, ...p } : r)));

  return (
    <div className="flex flex-col gap-4">
      <Section title="Agentenmodus" description="Archivist versteht eine Bitte, holt sich die nötigen Daten, plant mehrere Schritte und führt Änderungen aus.">
        <SwitchRow label="Agentenmodus einschalten" hint="Ohne KI oder im Modus „nur lokal“ gilt weiterhin die regelbasierte Auswertung.">
          <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Agentenmodus einschalten" data-testid="agent-enabled" />
        </SwitchRow>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Modus"
            htmlFor="agent-mode"
            hint="Löschen, Originaldateien, Datenschutz und Massenaktionen fragen immer. In jeder Unterhaltung kannst du den Modus oben umschalten."
          >
            <Select id="agent-mode" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} data-testid="agent-settings-mode">
              <option value="auto">Auto – Änderungen selbst ausführen (protokolliert, rückgängig machbar)</option>
              <option value="ask">Fragen – jede Änderung als Vorschlag vorbereiten</option>
            </Select>
          </Field>
          <Field label="Massenaktion ab … Einträgen" htmlFor="agent-threshold" hint="Ab dieser Zahl fragt Archivist in jedem Fall vorher.">
            <Input id="agent-threshold" type="number" min={1} max={100000} value={threshold} onChange={(e) => setThreshold(e.target.value)} />
          </Field>
          <Field label="Denktiefe" htmlFor="agent-effort" hint="Für Claude Opus 5.5 empfohlen: high">
            <Select id="agent-effort" value={effort} onChange={(e) => setEffort(e.target.value as typeof effort)} data-testid="agent-settings-effort">
              {EFFORTS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l} ({v})
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <SwitchRow label="Lernen" hint="Gelernte Regeln, Abläufe und Wissen werden jedem Lauf mitgegeben.">
          <Switch checked={learning} onCheckedChange={setLearning} aria-label="Lernen" data-testid="agent-learning" />
        </SwitchRow>
        <SwitchRow
          label="Websuche im Chat"
          hint="Archivist darf im Chat über den KI-Anbieter im Internet suchen (Claude oder OpenAI); die Quellen stehen unter der Antwort. Suchanfragen gehen an den Anbieter, Archivinhalte nicht. Hintergrundaufgaben suchen nie im Web."
        >
          <Switch checked={webSearch} onCheckedChange={setWebSearch} aria-label="Websuche im Chat" data-testid="agent-web-search" />
        </SwitchRow>
      </Section>

      <Section title="Hintergrund" description="Aufgaben, die Archivist ohne Chat erledigt. Ergebnisse erscheinen in der Glocke und unter „Agentenläufe“.">
        <SwitchRow label="Neue Dateien einsortieren" hint="Nach einer Suche oder einem Import.">
          <Switch checked={bg.inbox} onCheckedChange={(v) => setBg({ ...bg, inbox: v })} aria-label="Neue Dateien einsortieren" />
        </SwitchRow>
        <SwitchRow label="Archivprüfung auswerten" hint="Befunde bewerten und Aufräumarbeiten vorschlagen oder erledigen.">
          <Switch checked={bg.archiveCheck} onCheckedChange={(v) => setBg({ ...bg, archiveCheck: v })} aria-label="Archivprüfung auswerten" />
        </SwitchRow>
        <SwitchRow label="Verknüpfungen vorschlagen" hint="Für Einträge ohne Verbindung (nur Vorschläge).">
          <Switch checked={bg.links} onCheckedChange={(v) => setBg({ ...bg, links: v })} aria-label="Verknüpfungen vorschlagen" />
        </SwitchRow>
        <Field label="Nachtlauf (Archivprüfung und Verknüpfungen)" htmlFor="agent-nightly">
          <Select
            id="agent-nightly"
            value={bg.nightlyHour === null ? '' : String(bg.nightlyHour)}
            onChange={(e) => setBg({ ...bg, nightlyHour: e.target.value === '' ? null : Number(e.target.value) })}
          >
            <option value="">aus</option>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                um {String(h).padStart(2, '0')}:00 Uhr
              </option>
            ))}
          </Select>
        </Field>
        <SwitchRow label="Fristen-Wächter" hint="Meldet anstehende Fristen, überfällige offene Punkte und Erinnerungen.">
          <Switch checked={bg.deadlineWatch} onCheckedChange={(v) => setBg({ ...bg, deadlineWatch: v })} aria-label="Fristen-Wächter" />
        </SwitchRow>
        {bg.deadlineWatch && (
          <Field label="Vorlauf (Tage)" htmlFor="agent-lead">
            <Input id="agent-lead" type="number" min={1} max={365} className="w-32" value={leadDays} onChange={(e) => setLeadDays(e.target.value)} />
          </Field>
        )}
        <SwitchRow label="Wochenrückblick" hint="In einer eigenen Unterhaltung.">
          <Switch checked={bg.weeklyReview} onCheckedChange={(v) => setBg({ ...bg, weeklyReview: v })} aria-label="Wochenrückblick" />
        </SwitchRow>
        {bg.weeklyReview && (
          <Field label="Wochentag" htmlFor="agent-weekday">
            <Select id="agent-weekday" value={String(bg.weeklyReviewDay)} onChange={(e) => setBg({ ...bg, weeklyReviewDay: Number(e.target.value) })}>
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </Section>

      <Section title="Erweitert" description="Technische Grenzen schützen vor endlosen Läufen. Es gibt keine Kostenobergrenze.">
        <Field label="Schnittstelle (Adapter)" htmlFor="agent-adapter" hint="Automatisch: wird aus der Adresse der KI abgeleitet.">
          <Select id="agent-adapter" value={adapter} onChange={(e) => setAdapter(e.target.value as typeof adapter)} data-testid="agent-settings-adapter">
            <option value="auto">Automatisch</option>
            <option value="anthropic">Claude (Anthropic)</option>
            <option value="openai">OpenAI-kompatibel</option>
          </Select>
        </Field>
        <LimitsFields id="agent-chat" title="Grenzen im Chat" value={chat} onChange={setChat} />
        <LimitsFields id="agent-bg" title="Grenzen im Hintergrund" value={bgLimits} onChange={setBgLimits} />
        <Field label="Wiederholungen pro Anfrage" htmlFor="agent-retries" hint="Nach Ratenlimits, Server- oder Netzwerkfehlern (0 bis 10).">
          <Input id="agent-retries" type="number" min={0} max={10} className="w-32" value={retries} onChange={(e) => setRetries(e.target.value)} />
        </Field>
        <fieldset className="rounded-lg border p-3">
          <legend className="px-1 text-sm font-medium">Eigene Preise (optional, US$ pro 1 Mio. Tokens)</legend>
          <p className="text-xs text-muted-foreground">Überschreiben die eingebaute Preistabelle – nur für die Anzeige des Verbrauchs.</p>
          {prices.length > 0 && (
            <div className="mt-2 flex flex-col gap-2">
              {prices.map((row, i) => (
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
                    onClick={() => setPrices((rows) => rows.filter((_, j) => j !== i))}
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
            onClick={() =>
              setPrices((rows) => [...rows, { key: ++rowCounter, model: settings.llm.model, input: '', output: '', cacheRead: '', cacheWrite: '' }])
            }
          >
            <Plus aria-hidden /> Preis hinzufügen
          </Button>
        </fieldset>
      </Section>

      {error && (
        <Notice tone="warning" role="alert">
          {error}
        </Notice>
      )}
      <div className="flex items-center gap-2">
        <Button disabled={busy || error !== null} onClick={() => patch.ok && void save({ agent: patch.value })} data-testid="agent-settings-save">
          <Save aria-hidden /> Speichern
        </Button>
        {!enabled && <Badge variant="secondary">Agentenmodus aus</Badge>}
      </div>

      <CapabilitySection onApply={(url) => void save({ llm: { baseUrl: url } }, 'Adresse der KI übernommen.')} />
    </div>
  );
}
