'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { checkLlmBaseUrl, type IpcOutput, type ReasoningEffort } from '@archivist/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useApp } from '@/lib/app-context';
import { call } from '@/lib/ipc';
import { loadSettings } from '@/lib/use-settings';
import { useRun } from '@/lib/use-run';
import { cn } from '@/lib/utils';
import { DoneStep, LlmStep, PrivacyStep, ScanStep, WelcomeStep, type ConnectionTest, type LlmForm, type Mode } from './setup-steps';

type Step = 'welcome' | 'llm' | 'scan' | 'privacy' | 'done';
const STEPS: Step[] = ['welcome', 'llm', 'scan', 'privacy', 'done'];
const STEP_LABELS: Record<Step, string> = {
  welcome: 'Willkommen',
  llm: 'KI-Verbindung',
  scan: 'Verzeichnisse',
  privacy: 'Datenschutz',
  done: 'Fertig',
};

export function SetupWizard() {
  const { refreshStatus, status } = useApp();
  const { run, busy } = useRun();
  const [step, setStep] = useState<Step>('welcome');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<ReasoningEffort | ''>('');
  const [test, setTest] = useState<ConnectionTest | null>(null);
  const [testing, setTesting] = useState(false);
  const [directories, setDirectories] = useState<IpcOutput<'scanner:listDirectories'>>([]);
  const [mode, setMode] = useState<Mode>('confirm');
  const [profileName, setProfileName] = useState('');
  const [nicknames, setNicknames] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const { settings, hasApiKey } = await loadSettings();
        setBaseUrl(settings.llm.baseUrl);
        setModel(settings.llm.model);
        setEffort(settings.llm.reasoningEffort ?? '');
        setMode(settings.privacy.llmMode);
        setProfileName(settings.profile.name);
        setNicknames(settings.profile.nicknames.join(', '));
        setHasKey(hasApiKey);
        setDirectories(await call('scanner:listDirectories'));
      } catch {
        /* default values are sufficient */
      }
    })();
  }, []);

  const stepIndex = STEPS.indexOf(step);
  const go = (direction: 1 | -1) => setStep(STEPS[Math.min(STEPS.length - 1, Math.max(0, stepIndex + direction))] ?? 'welcome');
  const llmForm: LlmForm = { baseUrl, setBaseUrl, apiKey, setApiKey, hasKey, model, setModel, effort, setEffort };

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      const result = await call('llm:testConnection', {
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        ...(apiKey ? { apiKey } : {}),
      });
      setTest(result);
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
      .map((nickname) => nickname.trim())
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

  async function addDirectory() {
    await run(async () => {
      const selection = await call('app:selectDirectory', { title: 'Verzeichnis für die Dokumentensuche wählen' });
      if (!selection.path) return;
      await call('scanner:addDirectory', { path: selection.path, recursive: true });
      setDirectories(await call('scanner:listDirectories'));
    });
  }

  async function removeDirectory(id: string) {
    await run(async () => {
      await call('scanner:removeDirectory', { id });
      setDirectories(await call('scanner:listDirectories'));
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
            {STEPS.map((entry, i) => (
              <li key={entry} className="flex flex-1 flex-col gap-1" aria-current={i === stepIndex ? 'step' : undefined}>
                <span className={cn('h-1 rounded-full', i <= stepIndex ? 'bg-primary' : 'bg-muted')} />
                <span className={cn('hidden text-[11px] sm:block', i === stepIndex ? 'font-medium' : 'text-muted-foreground')}>{STEP_LABELS[entry]}</span>
              </li>
            ))}
          </ol>

          {step === 'welcome' && (
            <WelcomeStep
              profileName={profileName}
              onProfileNameChange={setProfileName}
              nicknames={nicknames}
              onNicknamesChange={setNicknames}
              syncProvider={status?.archiveSyncProvider ?? null}
            />
          )}
          {step === 'llm' && <LlmStep form={llmForm} test={test} testing={testing} onTest={() => void runTest()} />}
          {step === 'scan' && <ScanStep directories={directories} busy={busy} onAdd={() => void addDirectory()} onRemove={(id) => void removeDirectory(id)} />}
          {step === 'privacy' && <PrivacyStep mode={mode} onModeChange={setMode} />}
          {step === 'done' && <DoneStep tested={test?.ok === true} />}

          <div className="flex items-center justify-between pt-1">
            <Button variant="ghost" onClick={() => go(-1)} disabled={stepIndex === 0 || busy}>
              Zurück
            </Button>
            {step === 'welcome' && (
              <Button onClick={() => void saveProfileAndNext()} disabled={busy} data-testid="setup-next">
                Los geht’s
              </Button>
            )}
            {step === 'llm' && (
              <Button onClick={() => void saveLlmAndNext()} disabled={busy || !checkLlmBaseUrl(baseUrl).ok} data-testid="setup-next">
                {busy && <Loader2 className="animate-spin" aria-hidden />}
                {test?.ok ? 'Weiter' : 'Ohne Test weiter'}
              </Button>
            )}
            {step === 'scan' && (
              <Button onClick={() => go(1)} data-testid="setup-next">
                {directories.length > 0 ? 'Weiter' : 'Überspringen'}
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
