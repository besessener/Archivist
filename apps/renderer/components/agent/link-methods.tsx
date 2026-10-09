'use client';

import { useEffect, useRef, useState } from 'react';
import { Play, Undo2 } from 'lucide-react';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { Field } from '@/components/common/states';
import { Section, SwitchRow } from '@/components/settings/shared';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { call } from '@/lib/ipc';
import { plural } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';

/** The fixed link methods (#279, #290, #313): unlinked entries and the local, proposal-only retroactive run the agent also uses. */
export function LinkMethodsSection() {
  const unlinked = useQuery('links:unlinked', { limit: 1, offset: 0 }, { scopes: ['knowledge'] });
  const settings = useQuery('settings:get', {}, { scopes: ['settings'] });
  const { run, busy } = useRun();
  const [message, setMessage] = useState<string | null>(null);
  const total = unlinked.data?.total;
  const links = settings.data?.settings.links;
  const saveLinks = async (patch: { autoPropose?: boolean; maxProposalsPerEntry?: number; minConfidence?: number }): Promise<boolean> => {
    const saved = await run(() => call('settings:update', { links: patch }), { errorTitle: 'Speichern fehlgeschlagen' });
    if (saved) void settings.refetch();
    return Boolean(saved);
  };
  return (
    <Section
      title="Verknüpfungen vorschlagen"
      description="Neue und geänderte Einträge prüft Archivist selbst. Der Lauf hier geht das ganze Archiv erneut durch und schlägt ähnliche Einträge als Verknüpfung sowie neue Themen für ähnliche Einträge ohne Thema vor. Ähnliche Einträge sucht Archivist lokal; im Datenschutzmodus „automatisch“ analysiert die KI deine Notizen und benennt neue Themen. Bestätigt wird nur, was du übernimmst."
    >
      {links && (
        <>
          <SwitchRow
            label="Verknüpfungen automatisch vorschlagen"
            hint="Nach jedem neuen oder geänderten Eintrag sucht Archivist lokal nach ähnlichen Einträgen; Einträge aus derselben Nachricht oder demselben Dokument gehören zusammen. Alles bleibt ein Vorschlag. Warten 20 Vorschläge auf deine Prüfung, kommen neue erst, wenn du entschieden hast."
          >
            <Switch
              checked={links.autoPropose}
              disabled={busy}
              onCheckedChange={(checked) => void saveLinks({ autoPropose: checked })}
              aria-label="Verknüpfungen automatisch vorschlagen"
              data-testid="links-auto-propose"
            />
          </SwitchRow>
          <Field label="Höchstens offene Vorschläge je Eintrag" htmlFor="links-max-proposals">
            <Select
              id="links-max-proposals"
              className="w-24"
              value={String(links.maxProposalsPerEntry)}
              disabled={busy}
              onChange={(e) => void saveLinks({ maxProposalsPerEntry: Number(e.target.value) })}
              data-testid="links-max-proposals"
            >
              {[1, 2, 3, 5, 10].map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </Select>
          </Field>
          <MinConfidenceSlider value={links.minConfidence ?? 0} onCommit={(minConfidence) => saveLinks({ minConfidence })} />
        </>
      )}
      <p className="text-sm" data-testid="links-unlinked-count">
        {total === undefined
          ? 'Zähle Einträge ohne Verknüpfung …'
          : total === 0
            ? 'Alle Einträge sind verknüpft.'
            : `${plural(total, ['Eintrag', 'Einträge'])} ohne Verknüpfung.`}
      </p>
      <div>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          data-testid="links-start-run"
          onClick={async () => {
            const started = await run(() => call('links:startRun', {}), { errorTitle: 'Start fehlgeschlagen' });
            if (started) setMessage('Gestartet. Der Fortschritt erscheint unter „Verarbeitung“, das Ergebnis als ein Hinweis in der Glocke.');
          }}
        >
          <Play aria-hidden /> Verknüpfungslauf starten
        </Button>
      </div>
      {message && (
        <p className="text-xs text-muted-foreground" role="status">
          {message}
        </p>
      )}
      <LearnedThresholds />
    </Section>
  );
}

/** Proposals below this confidence are neither made nor shown; the value is saved on the native `change` (release, key or assistive technology). */
function MinConfidenceSlider({ value, onCommit }: { value: number; onCommit: (value: number) => Promise<boolean> }) {
  const [draft, setDraft] = useState(value);
  const slider = useRef<HTMLInputElement>(null);
  // a value saved elsewhere shows up, but never under the user's hand while the own saves land
  useEffect(() => {
    if (document.activeElement !== slider.current) setDraft(value);
  }, [value]);
  useEffect(() => {
    const element = slider.current;
    if (!element) return;
    const commit = async () => {
      const chosen = Number(element.value) / 100;
      if (chosen !== value && !(await onCommit(chosen))) setDraft(value);
    };
    const onChange = () => void commit();
    element.addEventListener('change', onChange);
    return () => element.removeEventListener('change', onChange);
  }, [value, onCommit]);
  const percent = Math.round(draft * 100);
  return (
    <Field
      label="Mindest-Sicherheit für Vorschläge"
      htmlFor="links-min-confidence"
      hint="Vorschläge mit geringerer Sicherheit werden weder angelegt noch angezeigt. 0 % zeigt alles, höhere Werte zeigen nur die sichersten."
    >
      <div className="flex items-center gap-3">
        <input
          id="links-min-confidence"
          type="range"
          min={0}
          max={100}
          step={5}
          className="w-48 accent-primary"
          ref={slider}
          value={percent}
          onChange={(e) => setDraft(Number(e.target.value) / 100)}
          data-testid="links-min-confidence"
        />
        <span className="w-12 text-sm tabular-nums">{percent} %</span>
      </div>
    </Field>
  );
}

/** What the link methods learned from rejections (#275): stricter thresholds within a cap, viewable and resettable. */
function LearnedThresholds() {
  const thresholds = useQuery('links:thresholds', {}, { scopes: ['knowledge', 'settings'] });
  const { run } = useRun();
  const [resetting, setResetting] = useState(false);
  if (!thresholds.data) return null;
  const points = (value: number) => `+${Math.round(value * 100)} Punkte`;
  return (
    <div className="flex flex-col gap-2" data-testid="links-thresholds">
      <h3 className="text-sm font-medium">Aus Ablehnungen gelernt</h3>
      <p className="text-xs text-muted-foreground">
        Lehnst du die meisten der letzten Vorschläge einer Methode ab, wird sie etwas strenger – höchstens um den angegebenen Deckel, Bestätigungen senken die
        Schwelle wieder. Abgeschaltet wird keine Methode; abgelehnte Paare kommen ohnehin nie wieder.
      </p>
      <table className="w-full text-left text-sm tabular-nums">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className="font-normal">Methode</th>
            <th className="font-normal">zuletzt bestätigt / abgelehnt</th>
            <th className="font-normal">gelernt</th>
            <th className="font-normal">Deckel</th>
          </tr>
        </thead>
        <tbody>
          {thresholds.data.map((threshold) => (
            <tr key={threshold.method} data-testid="links-threshold-row" data-method={threshold.method}>
              <td>
                {threshold.label} <span className="text-xs text-muted-foreground">({threshold.measure})</span>
              </td>
              <td>
                {threshold.confirmed} / {threshold.rejected}
              </td>
              <td>{threshold.offset > 0 ? points(threshold.offset) : 'unverändert'}</td>
              <td>{points(threshold.cap)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div>
        <Button variant="outline" size="sm" data-testid="links-thresholds-reset" onClick={() => setResetting(true)}>
          <Undo2 aria-hidden /> Gelerntes zurücksetzen
        </Button>
      </div>
      <ConfirmDialog
        open={resetting}
        onOpenChange={setResetting}
        title="Gelernte Schwellen zurücksetzen?"
        description="Alle Methoden schlagen wieder mit ihrer ursprünglichen Schwelle vor; nur deine künftigen Entscheidungen zählen. Abgelehnte Paare bleiben abgelehnt."
        confirmLabel="Zurücksetzen"
        onConfirm={async () => {
          const reset = await run(() => call('links:resetThresholds', { confirmed: true }), { success: 'Gelernte Schwellen zurückgesetzt.' });
          if (reset) void thresholds.refetch();
          setResetting(false);
        }}
      />
    </div>
  );
}
