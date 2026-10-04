'use client';

import { Archive, CheckCircle2, FolderPlus, Loader2, PlugZap, ShieldCheck, Trash2, TriangleAlert } from 'lucide-react';
import { connectionTitle, connectionTone } from '@/lib/labels';
import { checkLlmBaseUrl, type IpcOutput, type ReasoningEffort } from '@archivist/shared';
import { EFFORT_HINT, EffortOptions } from '@/components/settings/effort-options';
import { AgentCapabilityNote } from '@/components/agent/capability-note';
import { Field, Notice } from '@/components/common/states';
import { SyncFolderNotice } from '@/components/common/sync-folder-notice';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';

export type Mode = 'auto' | 'confirm' | 'local_only';
export type ConnectionTest = IpcOutput<'llm:testConnection'>;
type Directory = IpcOutput<'scanner:listDirectories'>[number];

const MODES: Array<{ id: Mode; title: string; text: string }> = [
  {
    id: 'confirm',
    title: 'Vor jeder externen Analyse fragen (empfohlen)',
    text: 'Archivist analysiert Dokumentinhalte nur mit der KI, nachdem du es jeweils bestätigt hast. Was du im Chat schreibst, geht zur Auswertung an die KI. Erkannte Geheimnisse wie Passwörter werden vorher maskiert.',
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

export function WelcomeStep({
  profileName,
  onProfileNameChange,
  nicknames,
  onNicknamesChange,
  syncProvider,
  dataSyncProvider,
}: {
  syncProvider: string | null;
  dataSyncProvider: string | null;
  profileName: string;
  onProfileNameChange: (name: string) => void;
  nicknames: string;
  onNicknamesChange: (nicknames: string) => void;
}) {
  return (
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
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden /> Nichts wird ohne deine Bestätigung verschoben, gelöscht oder umbenannt.
        </li>
        <li className="flex gap-2">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden /> Die Einrichtung dauert etwa zwei Minuten.
        </li>
      </ul>
      <SyncFolderNotice provider={syncProvider} dataProvider={dataSyncProvider} data-testid="setup-sync-warning" />
      <Field
        label="Dein Name (optional)"
        htmlFor="setup-profile-name"
        hint="Damit „ich“ im Chat und Dokumente mit deinem Namen dir zugeordnet werden. Später unter Einstellungen → Über dich änderbar."
      >
        <Input
          id="setup-profile-name"
          value={profileName}
          onChange={(e) => onProfileNameChange(e.target.value)}
          placeholder="z. B. Monika Lor-Zade"
          data-testid="setup-profile-name"
        />
      </Field>
      <Field label="Spitznamen (optional, durch Komma getrennt)" htmlFor="setup-profile-nicknames">
        <Input id="setup-profile-nicknames" value={nicknames} onChange={(e) => onNicknamesChange(e.target.value)} data-testid="setup-profile-nicknames" />
      </Field>
    </div>
  );
}

export interface LlmForm {
  baseUrl: string;
  setBaseUrl: (value: string) => void;
  apiKey: string;
  setApiKey: (value: string) => void;
  hasKey: boolean;
  model: string;
  setModel: (value: string) => void;
  effort: ReasoningEffort | '';
  setEffort: (value: ReasoningEffort | '') => void;
}

export function LlmStep({ form, test, testing, onTest }: { form: LlmForm; test: ConnectionTest | null; testing: boolean; onTest: () => void }) {
  const baseUrlCheck = checkLlmBaseUrl(form.baseUrl);
  const baseUrlError = baseUrlCheck.ok ? undefined : baseUrlCheck.message;
  return (
    <div className="flex flex-col gap-4" data-testid="setup-step-llm">
      <div>
        <h2 className="text-xl font-semibold">Verbindung zur KI</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Archivist nutzt einen KI-Dienst, der die OpenAI-Schnittstelle versteht (z. B. OpenAI oder ein eigener Server). Die Zugangsdaten bekommst du von deinem
          Anbieter oder deiner IT.
        </p>
      </div>
      <Field label="Adresse des Dienstes (Base URL)" htmlFor="setup-baseurl" hint="Beispiel: https://api.openai.com/v1" error={baseUrlError}>
        <Input
          id="setup-baseurl"
          data-testid="setup-baseurl"
          aria-invalid={baseUrlError ? true : undefined}
          aria-describedby={baseUrlError ? 'setup-baseurl-error' : undefined}
          value={form.baseUrl}
          onChange={(e) => form.setBaseUrl(e.target.value)}
          placeholder="https://…/v1"
          autoComplete="off"
        />
      </Field>
      <Field
        label="API-Schlüssel"
        htmlFor="setup-apikey"
        hint={
          form.hasKey
            ? 'Es ist bereits ein Schlüssel gespeichert. Leer lassen, um ihn zu behalten.'
            : 'Wird verschlüsselt auf diesem Computer gespeichert und nie angezeigt.'
        }
      >
        <Input
          id="setup-apikey"
          data-testid="setup-apikey"
          type="password"
          value={form.apiKey}
          onChange={(e) => form.setApiKey(e.target.value)}
          autoComplete="off"
          placeholder={form.hasKey ? '••••••••' : ''}
        />
      </Field>
      <Field label="Modellname" htmlFor="setup-model">
        <Input
          id="setup-model"
          data-testid="setup-model"
          value={form.model}
          onChange={(e) => form.setModel(e.target.value)}
          placeholder="z. B. gpt-5"
          autoComplete="off"
        />
      </Field>
      <Field label="Denktiefe (optional)" htmlFor="setup-effort" hint={`${EFFORT_HINT} Im Zweifel leer lassen.`}>
        <Select id="setup-effort" value={form.effort} onChange={(e) => form.setEffort(e.target.value as ReasoningEffort | '')}>
          <EffortOptions />
        </Select>
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" onClick={onTest} disabled={testing || !form.baseUrl.trim() || Boolean(baseUrlError)} data-testid="setup-test">
          {testing ? <Loader2 className="animate-spin" aria-hidden /> : <PlugZap aria-hidden />} Verbindung testen
        </Button>
      </div>
      {test && <ConnectionTestResult test={test} onApplyBaseUrl={form.setBaseUrl} />}
      {!test?.ok && (
        <Notice tone="warning" title="Verbindung noch nicht geprüft" data-testid="setup-skip-warning">
          <span className="flex gap-2">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              Du kannst den Test überspringen. Dann kann Archivist Dokumente und Fragen vorerst nicht mit der KI auswerten – du kannst die Verbindung jederzeit
              in den Einstellungen nachholen.
            </span>
          </span>
        </Notice>
      )}
    </div>
  );
}

function ConnectionTestResult({ test, onApplyBaseUrl }: { test: ConnectionTest; onApplyBaseUrl: (baseUrl: string) => void }) {
  return (
    <Notice tone={connectionTone(test)} title={connectionTitle(test)} data-testid="setup-test-result">
      <p>{test.message}</p>
      {test.ok && test.latencyMs !== null && <p className="mt-1 text-xs">Antwortzeit: {test.latencyMs} ms</p>}
      {!test.ok && test.error && <p className="mt-1 text-xs">{test.error.message}</p>}
      {test.ok && test.structured && !test.structured.ok && <p className="mt-1 text-xs">{test.structured.message}</p>}
      {test.ok && test.agent && <AgentCapabilityNote capability={test.agent} onApplyBaseUrl={onApplyBaseUrl} testId="setup-agent-capability" />}
    </Notice>
  );
}

export function ScanStep({
  directories,
  busy,
  onAdd,
  onRemove,
}: {
  directories: Directory[];
  busy: boolean;
  onAdd: () => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4" data-testid="setup-step-scan">
      <div>
        <h2 className="text-xl font-semibold">Dokumente auf diesem Computer finden (optional)</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Archivist kann Ordner nach neuen Dokumenten durchsuchen. Das ist <strong>standardmäßig ausgeschaltet</strong> – auch wenn du hier Ordner hinzufügst,
          wird erst gesucht, wenn du es auf der Seite „Scan“ oder in den Einstellungen ausdrücklich einschaltest. Gesucht wird nur, solange die App läuft.
        </p>
      </div>
      <Button variant="outline" className="w-fit" onClick={onAdd} disabled={busy} data-testid="setup-add-dir">
        <FolderPlus aria-hidden /> Verzeichnis hinzufügen
      </Button>
      {directories.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {directories.map((directory) => (
            <li key={directory.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
              <code className="min-w-0 break-all text-xs">{directory.path}</code>
              <Button variant="ghost" size="icon-sm" aria-label={`${directory.path} entfernen`} onClick={() => onRemove(directory.id)}>
                <Trash2 aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">Noch keine Verzeichnisse – du kannst diesen Schritt überspringen.</p>
      )}
    </div>
  );
}

export function PrivacyStep({ mode, onModeChange }: { mode: Mode; onModeChange: (mode: Mode) => void }) {
  return (
    <fieldset className="flex flex-col gap-3" data-testid="setup-step-privacy">
      <legend className="mb-1 text-xl font-semibold">Datenschutz</legend>
      <p className="text-sm text-muted-foreground">Wähle, wann Dokumentinhalte an den KI-Dienst gesendet werden dürfen. Du kannst das jederzeit ändern.</p>
      {MODES.map((option) => (
        <label
          key={option.id}
          className={cn(
            'flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring',
            mode === option.id ? 'border-primary bg-primary/8' : 'hover:bg-accent/50',
          )}
        >
          <input
            type="radio"
            name="llm-mode"
            className="mt-1 accent-[var(--primary)]"
            checked={mode === option.id}
            onChange={() => onModeChange(option.id)}
            data-testid={`setup-mode-${option.id}`}
          />
          <span>
            <span className="block text-sm font-medium">{option.title}</span>
            <span className="block text-sm text-muted-foreground">{option.text}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export function DoneStep({ tested }: { tested: boolean }) {
  return (
    <div className="flex flex-col gap-4" data-testid="setup-step-done">
      <span className="flex size-12 items-center justify-center rounded-xl bg-success/15 text-success">
        <ShieldCheck className="size-6" aria-hidden />
      </span>
      <h2 className="text-xl font-semibold">Alles bereit</h2>
      <p className="text-muted-foreground">
        Du kannst jetzt im Chat Entscheidungen festhalten, Fragen stellen oder Dateien per Drag-and-Drop in das Fenster ziehen. Änderungen am Archiv passieren
        immer erst nach deiner Bestätigung.
      </p>
      {!tested && <Notice tone="warning">Die KI-Verbindung wurde nicht erfolgreich getestet. Prüfe sie später unter Einstellungen → KI.</Notice>}
    </div>
  );
}
