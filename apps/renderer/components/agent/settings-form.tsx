'use client';

import { useState } from 'react';
import type { AgentSettings } from '@archivist/shared';
import { Save } from 'lucide-react';
import { Field, Notice } from '@/components/common/states';
import { Section, SwitchRow, useSaveSettings, type TabProps } from '@/components/settings/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { BackgroundSection, CapabilitySection, LimitsFields, PriceTable, priceRowsFrom } from './settings-fields';
import { KindLimitsFields } from './kind-limits-fields';
import { fail, intIn, parseKindLimits, parseLimits, parsePrices, toKindLimits, toLimits, type AgentPatch, type Parsed, type PriceRow } from './settings-parse';

const EFFORTS: Array<[AgentSettings['effort'], string]> = [
  ['low', 'niedrig'],
  ['medium', 'mittel'],
  ['high', 'hoch'],
  ['xhigh', 'sehr hoch'],
  ['max', 'maximal'],
];

/** Settings of the agent mode (#294, #298, #313, #315). */
export function AgentSettingsForm({ settings, reload }: TabProps) {
  const agent = settings.agent;
  const { save, busy } = useSaveSettings(reload);
  const [enabled, setEnabled] = useState(agent.enabled);
  const [mode, setMode] = useState(agent.mode);
  const [threshold, setThreshold] = useState(String(agent.massActionThreshold));
  const [effort, setEffort] = useState(agent.effort);
  const [adapter, setAdapter] = useState(agent.adapter);
  const [chat, setChat] = useState(toLimits(agent.chatLimits));
  const [backgroundLimits, setBackgroundLimits] = useState(toLimits(agent.backgroundLimits));
  const [kindLimits, setKindLimits] = useState(toKindLimits(agent.backgroundKindLimits));
  const [retries, setRetries] = useState(String(agent.maxRetries));
  const [learning, setLearning] = useState(agent.learning);
  const [webSearch, setWebSearch] = useState(agent.webSearch);
  const [background, setBackground] = useState(agent.background);
  const [leadDays, setLeadDays] = useState(String(agent.background.deadlineLeadDays));
  const [prices, setPrices] = useState<PriceRow[]>(() => priceRowsFrom(agent.prices));

  function build(): Parsed<AgentPatch> {
    const massActionThreshold = intIn(threshold, { min: 1, max: 100_000 });
    if (massActionThreshold === null) return fail('Massenaktionen: Schwelle zwischen 1 und 100.000.');
    const maxRetries = intIn(retries, { min: 0, max: 10 });
    if (maxRetries === null) return fail('Wiederholungen: 0 bis 10.');
    const chatLimits = parseLimits(chat, 'Chat');
    if (!chatLimits.ok) return chatLimits;
    const parsedBackgroundLimits = parseLimits(backgroundLimits, 'Hintergrund');
    if (!parsedBackgroundLimits.ok) return parsedBackgroundLimits;
    const parsedKindLimits = parseKindLimits(kindLimits);
    if (!parsedKindLimits.ok) return parsedKindLimits;
    const deadlineLeadDays = intIn(leadDays, { min: 1, max: 365 });
    if (deadlineLeadDays === null) return fail('Fristen-Wächter: Vorlauf zwischen 1 und 365 Tagen.');
    const priceTable = parsePrices(prices);
    if (!priceTable.ok) return priceTable;
    return {
      ok: true,
      value: {
        enabled,
        mode,
        massActionThreshold,
        effort,
        adapter,
        chatLimits: chatLimits.value,
        backgroundLimits: parsedBackgroundLimits.value,
        backgroundKindLimits: parsedKindLimits.value,
        maxRetries,
        learning,
        webSearch,
        prices: priceTable.value,
        background: { ...background, deadlineLeadDays },
      },
    };
  }

  const patch = build();
  const error = patch.ok ? null : patch.error;

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
              {EFFORTS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label} ({value})
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

      <BackgroundSection background={background} onChange={setBackground} leadDays={leadDays} onLeadDaysChange={setLeadDays} />

      <Section title="Erweitert" description="Technische Grenzen schützen vor endlosen Läufen. Es gibt keine Kostenobergrenze.">
        <Field label="Schnittstelle (Adapter)" htmlFor="agent-adapter" hint="Automatisch: wird aus der Adresse der KI abgeleitet.">
          <Select id="agent-adapter" value={adapter} onChange={(e) => setAdapter(e.target.value as typeof adapter)} data-testid="agent-settings-adapter">
            <option value="auto">Automatisch</option>
            <option value="anthropic">Claude (Anthropic)</option>
            <option value="openai">OpenAI-kompatibel</option>
          </Select>
        </Field>
        <LimitsFields id="agent-chat" title="Grenzen im Chat" value={chat} onChange={setChat} />
        <LimitsFields id="agent-bg" title="Grenzen im Hintergrund" value={backgroundLimits} onChange={setBackgroundLimits} />
        <KindLimitsFields value={kindLimits} onChange={setKindLimits} />
        <Field label="Wiederholungen pro Anfrage" htmlFor="agent-retries" hint="Nach Ratenlimits, Server- oder Netzwerkfehlern (0 bis 10).">
          <Input id="agent-retries" type="number" min={0} max={10} className="w-32" value={retries} onChange={(e) => setRetries(e.target.value)} />
        </Field>
        <PriceTable rows={prices} onChange={setPrices} defaultModel={settings.llm.model} />
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
