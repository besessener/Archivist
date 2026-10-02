'use client';

import { useEffect, useState } from 'react';
import { Archive, CheckCircle2, FolderPlus, Loader2, PlugZap, ShieldCheck, Trash2, TriangleAlert } from 'lucide-react';
import { Notice } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Field } from '@/components/common/states';
import { useApp } from '@/lib/app-context';
import { call } from '@/lib/ipc';
import { loadSettings } from '@/lib/use-settings';
import { useRun } from '@/lib/use-run';
import { cn } from '@/lib/utils';
import type { IpcOutput } from '@archivist/shared';

type Step = 'welcome' | 'llm' | 'scan' | 'privacy' | 'done';
const STEPS: Step[] = ['welcome', 'llm', 'scan', 'privacy', 'done'];
const STEP_LABELS: Record<Step, string> = {
  welcome: 'Willkommen',
  llm: 'KI-Verbindung',
  scan: 'Verzeichnisse',
  privacy: 'Datenschutz',
  done: 'Fertig',
};

type Mode = 'auto' | 'confirm' | 'local_only';
type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high';

const MODES: Array<{ id: Mode; title: string; text: string }> = [
  {
    id: 'confirm',
    title: 'Vor jeder externen Analyse fragen (empfohlen)',
    text: 'Archivist analysiert Dokumentinhalte nur mit der KI, nachdem du es jeweils bestätigt hast. Erkannte Geheimnisse wie Passwörter werden vorher maskiert.',
  },
  {
    id: 'auto',
    title: 'Automatisch analysieren',
    text: 'Inhalte importierter Dokumente werden ohne Rückfrage an deinen KI-Dienst gesendet, damit Vorschläge sofort bereitstehen.',
  },
  {
    id: 'local_only',
    title: 'Nur lokal – nichts an die KI senden',
    text: 'Es werden keine Dokumentinhalte an einen externen Dienst übertragen. Archivist arbeitet nur mit einfachen lokalen Funktionen; Vorschläge sind weniger genau.',
  },
];

export function SetupWizard() {
  const { refreshStatus } = useApp();
  const { run, busy } = useRun();
  const [step, setStep] = useState<Step>('welcome');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<Effort | ''>('');
  const [test, setTest] = useState<IpcOutput<'llm:testConnection'> | null>(null);
  const [testing, setTesting] = useState(false);
  const [dirs, setDirs] = useState<IpcOutput<'scanner:listDirectories'>>([]);
  const [mode, setMode] = useState<Mode>('confirm');
  const [profileName, setProfileName] = useState('');
  const [nicknames, setNicknames] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const s = await loadSettings();
        setBaseUrl(s.settings.llm.baseUrl);
        setModel(s.settings.llm.model);
        setEffort(s.settings.llm.reasoningEffort ?? '');
        setMode(s.settings.privacy.llmMode);
        setProfileName(s.settings.profile.name);
        setNicknames(s.settings.profile.nicknames.join(', '));
        setHasKey(s.hasApiKey);
        setDirs(await call('scanner:listDirectories'));
      } catch {
        /* Standardwerte genügen */
      }
    })();
  }, []);

  const idx = STEPS.indexOf(step);
  const go = (d: 1 | -1) => setStep(STEPS[Math.min(STEPS.length - 1, Math.max(0, idx + d))] ?? 'welcome');

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      const res = await call('llm:testConnection', {
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        ...(apiKey ? { apiKey } : {}),
      });
      setTest(res);
    } catch (err) {
      setTest({ ok: false, latencyMs: null, message: err instanceof Error ? err.message : 'Test fehlgeschlagen.', modelReply: null, error: null });
    } finally {
      setTesting(false);
    }
  }

  /** Name and nicknames are optional; they let Archivist link „ich“ in the chat and documents with the name to the user. */
  async function saveProfileAndNext() {
    const list = nicknames
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    const ok = await run(async () => {
      await call('settings:update', { profile: { name: profileName.trim(), nicknames: list } });
      return true;
    });
    if (ok) go(1);
  }

  async function saveLlmAndNext() {
    const ok = await run(async () => {
      await call('settings:update', {
        llm: { baseUrl: baseUrl.trim(), model: model.trim(), reasoningEffort: effort === '' ? null : effort },
      });
      if (apiKey.trim()) {
        await call('settings:setApiKey', { apiKey: apiKey.trim() });
        setHasKey(true);
        setApiKey('');
      }
      return true;
    });
    if (ok) go(1);
  }

  async function addDir() {
    await run(async () => {
      const sel = await call('app:selectDirectory', { title: 'Verzeichnis für die Dokumentensuche wählen' });
      if (!sel.path) return;
      await call('scanner:addDirectory', { path: sel.path, recursive: true });
      setDirs(await call('scanner:listDirectories'));
    });
  }

  async function removeDir(id: string) {
    await run(async () => {
      await call('scanner:removeDirectory', { id });
      setDirs(await call('scanner:listDirectories'));
    });
  }

  async function finish() {
    const ok = await run(async () => {
      await call('settings:update', { privacy: { llmMode: mode } });
      await call('app:completeSetup');
      return true;
    });
    if (ok) await refreshStatus();
  }

  return (
    <div className="flex h-screen items-center justify-center overflow-y-auto bg-background p-4" data-testid="setup-wizard">
      <Card className="my-auto w-full max-w-xl">
        <CardContent className="flex flex-col gap-5 p-6">
          <ol className="flex items-center gap-1.5" aria-label="Fortschritt der Einrichtung">
            {STEPS.map((s, i) => (
              <li key={s} className="flex flex-1 flex-col gap-1" aria-current={i === idx ? 'step' : undefined}>
                <span className={cn('h-1 rounded-full', i <= idx ? 'bg-primary' : 'bg-muted')} />
                <span className={cn('hidden text-[11px] sm:block', i === idx ? 'font-medium' : 'text-muted-foreground')}>{STEP_LABELS[s]}</span>
              </li>
            ))}
          </ol>

          {step === 'welcome' && (
            <div className="flex flex-col gap-4" data-testid="setup-step-welcome">
              <span className="flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                <Archive className="size-6" aria-hidden />
              </span>
              <h1 className="text-2xl font-semibold tracking-tight">Willkommen bei Archivist</h1>
              <p className="text-muted-foreground">
                Archivist ist dein persönlicher Archivar: Er merkt sich Entscheidungen, offene Punkte und Dokumente, legt sie ordentlich ab und hilft dir, alles
                wiederzufinden – im Gespräch, in Worten, die du selbst benutzt.
              </p>
              <ul className="flex flex-col gap-2 text-sm text-muted-foreground">
                <li className="flex gap-2">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden /> Alle Daten bleiben auf diesem Computer.
                </li>
                <li className="flex gap-2">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden /> Nichts wird ohne deine Bestätigung verschoben, gelöscht oder
                  umbenannt.
                </li>
                <li className="flex gap-2">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden /> Die Einrichtung dauert etwa zwei Minuten.
                </li>
              </ul>
              <Field
                label="Dein Name (optional)"
                htmlFor="setup-profile-name"
                hint="Damit „ich“ im Chat und Dokumente mit deinem Namen dir zugeordnet werden. Später unter Einstellungen → Über dich änderbar."
              >
                <Input
                  id="setup-profile-name"
                  value={profileName}
                  onChange={(e) => setProfileName(e.target.value)}
                  placeholder="z. B. Monika Lor-Zade"
                  data-testid="setup-profile-name"
                />
              </Field>
              <Field label="Spitznamen (optional, durch Komma getrennt)" htmlFor="setup-profile-nicknames">
                <Input id="setup-profile-nicknames" value={nicknames} onChange={(e) => setNicknames(e.target.value)} data-testid="setup-profile-nicknames" />
              </Field>
            </div>
          )}

          {step === 'llm' && (
            <div className="flex flex-col gap-4" data-testid="setup-step-llm">
              <div>
                <h2 className="text-xl font-semibold">Verbindung zur KI</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Archivist nutzt einen KI-Dienst, der die OpenAI-Schnittstelle versteht (z. B. OpenAI oder ein eigener Server). Die Zugangsdaten bekommst du
                  von deinem Anbieter oder deiner IT.
                </p>
              </div>
              <Field label="Adresse des Dienstes (Base URL)" htmlFor="setup-baseurl" hint="Beispiel: https://api.openai.com/v1">
                <Input
                  id="setup-baseurl"
                  data-testid="setup-baseurl"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://…/v1"
                  autoComplete="off"
                />
              </Field>
              <Field
                label="API-Schlüssel"
                htmlFor="setup-apikey"
                hint={
                  hasKey
                    ? 'Es ist bereits ein Schlüssel gespeichert. Leer lassen, um ihn zu behalten.'
                    : 'Wird verschlüsselt auf diesem Computer gespeichert und nie angezeigt.'
                }
              >
                <Input
                  id="setup-apikey"
                  data-testid="setup-apikey"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  autoComplete="off"
                  placeholder={hasKey ? '••••••••' : ''}
                />
              </Field>
              <Field label="Modellname" htmlFor="setup-model">
                <Input
                  id="setup-model"
                  data-testid="setup-model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="z. B. gpt-5"
                  autoComplete="off"
                />
              </Field>
              <Field label="Denktiefe (optional)" htmlFor="setup-effort" hint="Nur für Modelle mit „Reasoning“. Im Zweifel leer lassen.">
                <Select id="setup-effort" value={effort} onChange={(e) => setEffort(e.target.value as Effort | '')}>
                  <option value="">Standard des Modells</option>
                  <option value="none">keine</option>
                  <option value="minimal">minimal</option>
                  <option value="low">niedrig</option>
                  <option value="medium">mittel</option>
                  <option value="high">hoch</option>
                </Select>
              </Field>
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="outline" onClick={() => void runTest()} disabled={testing || !baseUrl.trim()} data-testid="setup-test">
                  {testing ? <Loader2 className="animate-spin" aria-hidden /> : <PlugZap aria-hidden />} Verbindung testen
                </Button>
              </div>
              {test && (
                <Notice
                  tone={test.ok ? 'info' : 'danger'}
                  title={test.ok ? 'Verbindung erfolgreich' : 'Verbindung fehlgeschlagen'}
                  data-testid="setup-test-result"
                >
                  <p>{test.message}</p>
                  {test.ok && test.latencyMs !== null && <p className="mt-1 text-xs">Antwortzeit: {test.latencyMs} ms</p>}
                  {!test.ok && test.error && <p className="mt-1 text-xs">{test.error.message}</p>}
                </Notice>
              )}
              {!test?.ok && (
                <Notice tone="warning" title="Verbindung noch nicht geprüft" data-testid="setup-skip-warning">
                  <span className="flex gap-2">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                    <span>
                      Du kannst den Test überspringen. Dann kann Archivist Dokumente und Fragen vorerst nicht mit der KI auswerten – du kannst die Verbindung
                      jederzeit in den Einstellungen nachholen.
                    </span>
                  </span>
                </Notice>
              )}
            </div>
          )}

          {step === 'scan' && (
            <div className="flex flex-col gap-4" data-testid="setup-step-scan">
              <div>
                <h2 className="text-xl font-semibold">Dokumente auf diesem Computer finden (optional)</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Archivist kann Ordner nach neuen Dokumenten durchsuchen. Das ist <strong>standardmäßig ausgeschaltet</strong> – auch wenn du hier Ordner
                  hinzufügst, wird erst gesucht, wenn du es auf der Seite „Scan“ oder in den Einstellungen ausdrücklich einschaltest. Gesucht wird nur, solange
                  die App läuft.
                </p>
              </div>
              <Button variant="outline" className="w-fit" onClick={() => void addDir()} disabled={busy} data-testid="setup-add-dir">
                <FolderPlus aria-hidden /> Verzeichnis hinzufügen
              </Button>
              {dirs.length > 0 ? (
                <ul className="flex flex-col gap-2">
                  {dirs.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                      <code className="min-w-0 break-all text-xs">{d.path}</code>
                      <Button variant="ghost" size="icon-sm" aria-label={`${d.path} entfernen`} onClick={() => void removeDir(d.id)}>
                        <Trash2 aria-hidden />
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">Noch keine Verzeichnisse – du kannst diesen Schritt überspringen.</p>
              )}
            </div>
          )}

          {step === 'privacy' && (
            <fieldset className="flex flex-col gap-3" data-testid="setup-step-privacy">
              <legend className="mb-1 text-xl font-semibold">Datenschutz</legend>
              <p className="text-sm text-muted-foreground">
                Wähle, wann Dokumentinhalte an den KI-Dienst gesendet werden dürfen. Du kannst das jederzeit ändern.
              </p>
              {MODES.map((m) => (
                <label
                  key={m.id}
                  className={cn(
                    'flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring',
                    mode === m.id ? 'border-primary bg-primary/8' : 'hover:bg-accent/50',
                  )}
                >
                  <input
                    type="radio"
                    name="llm-mode"
                    className="mt-1 accent-[var(--primary)]"
                    checked={mode === m.id}
                    onChange={() => setMode(m.id)}
                    data-testid={`setup-mode-${m.id}`}
                  />
                  <span>
                    <span className="block text-sm font-medium">{m.title}</span>
                    <span className="block text-sm text-muted-foreground">{m.text}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}

          {step === 'done' && (
            <div className="flex flex-col gap-4" data-testid="setup-step-done">
              <span className="flex size-12 items-center justify-center rounded-xl bg-success/15 text-success">
                <ShieldCheck className="size-6" aria-hidden />
              </span>
              <h2 className="text-xl font-semibold">Alles bereit</h2>
              <p className="text-muted-foreground">
                Du kannst jetzt im Chat Entscheidungen festhalten, Fragen stellen oder Dateien per Drag-and-Drop in das Fenster ziehen. Änderungen am Archiv
                passieren immer erst nach deiner Bestätigung.
              </p>
              {!test?.ok && <Notice tone="warning">Die KI-Verbindung wurde nicht erfolgreich getestet. Prüfe sie später unter Einstellungen → KI.</Notice>}
            </div>
          )}

          <div className="flex items-center justify-between pt-1">
            <Button variant="ghost" onClick={() => go(-1)} disabled={idx === 0 || busy}>
              Zurück
            </Button>
            {step === 'welcome' && (
              <Button onClick={() => void saveProfileAndNext()} disabled={busy} data-testid="setup-next">
                Los geht’s
              </Button>
            )}
            {step === 'llm' && (
              <Button onClick={() => void saveLlmAndNext()} disabled={busy} data-testid="setup-next">
                {busy && <Loader2 className="animate-spin" aria-hidden />}
                {test?.ok ? 'Weiter' : 'Ohne Test weiter'}
              </Button>
            )}
            {step === 'scan' && (
              <Button onClick={() => go(1)} data-testid="setup-next">
                {dirs.length > 0 ? 'Weiter' : 'Überspringen'}
              </Button>
            )}
            {step === 'privacy' && (
              <Button onClick={() => go(1)} data-testid="setup-next">
                Weiter
              </Button>
            )}
            {step === 'done' && (
              <Button onClick={() => void finish()} disabled={busy} data-testid="setup-finish">
                {busy && <Loader2 className="animate-spin" aria-hidden />}
                Archivist starten
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
