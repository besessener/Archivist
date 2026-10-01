'use client';

import { useState } from 'react';
import { KeyRound, Loader2, PlugZap, Save, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { Field, Notice } from '@/components/common/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { call } from '@/lib/ipc';
import { useRun } from '@/lib/use-run';
import type { IpcOutput } from '@archivist/shared';
import { Section, useSaveSettings, type TabProps } from './shared';

type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high';

export function LlmTab({ settings, hasApiKey, reload }: TabProps) {
  const { save, busy } = useSaveSettings(reload);
  const { run, busy: keyBusy } = useRun();
  const [baseUrl, setBaseUrl] = useState(settings.llm.baseUrl);
  const [model, setModel] = useState(settings.llm.model);
  const [effort, setEffort] = useState<Effort | ''>(settings.llm.reasoningEffort ?? '');
  const [timeoutS, setTimeoutS] = useState(String(Math.round(settings.llm.timeoutMs / 1000)));
  const [maxChars, setMaxChars] = useState(String(settings.llm.maxInputChars));
  const [embedding, setEmbedding] = useState(settings.llm.embeddingModel);
  const [apiKey, setApiKey] = useState('');
  const [clearOpen, setClearOpen] = useState(false);
  const [test, setTest] = useState<IpcOutput<'llm:testConnection'> | null>(null);
  const [testing, setTesting] = useState(false);

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      setTest(await call('llm:testConnection', { baseUrl: baseUrl.trim(), model: model.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }));
    } catch (err) {
      setTest({ ok: false, latencyMs: null, message: err instanceof Error ? err.message : 'Test fehlgeschlagen.', modelReply: null, error: null });
    } finally {
      setTesting(false);
    }
  }

  const timeout = Number(timeoutS);
  const chars = Number(maxChars);
  const valid = timeout >= 1 && timeout <= 600 && chars >= 500 && chars <= 2000000;

  return (
    <div className="flex flex-col gap-4">
      <Section title="Verbindung zur KI" description="Jeder Dienst mit OpenAI-kompatibler Schnittstelle funktioniert.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Adresse (Base URL)" htmlFor="s-baseurl" className="sm:col-span-2">
            <Input id="s-baseurl" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…/v1" data-testid="settings-baseurl" />
          </Field>
          <Field label="Modellname" htmlFor="s-model">
            <Input id="s-model" value={model} onChange={(e) => setModel(e.target.value)} data-testid="settings-model" />
          </Field>
          <Field label="Denktiefe (Reasoning)" htmlFor="s-effort">
            <Select id="s-effort" value={effort} onChange={(e) => setEffort(e.target.value as Effort | '')} data-testid="settings-effort">
              <option value="">Standard des Modells</option>
              <option value="none">keine</option>
              <option value="minimal">minimal</option>
              <option value="low">niedrig</option>
              <option value="medium">mittel</option>
              <option value="high">hoch</option>
            </Select>
          </Field>
          <Field label="Zeitlimit (Sekunden)" htmlFor="s-timeout" hint="1 bis 600">
            <Input id="s-timeout" type="number" min={1} max={600} value={timeoutS} onChange={(e) => setTimeoutS(e.target.value)} />
          </Field>
          <Field label="Maximale Eingabegröße (Zeichen)" htmlFor="s-max" hint="Längere Texte werden gekürzt. 500 bis 2.000.000.">
            <Input id="s-max" type="number" min={500} max={2000000} value={maxChars} onChange={(e) => setMaxChars(e.target.value)} />
          </Field>
          <Field label="Embedding-Modell (optional)" htmlFor="s-embed" hint="Leer lassen für die lokale Ähnlichkeitssuche." className="sm:col-span-2">
            <Input id="s-embed" value={embedding} onChange={(e) => setEmbedding(e.target.value)} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={busy || !valid}
            data-testid="settings-save"
            onClick={() =>
              void save({
                llm: {
                  baseUrl: baseUrl.trim(),
                  model: model.trim(),
                  reasoningEffort: effort === '' ? null : effort,
                  timeoutMs: Math.round(timeout * 1000),
                  maxInputChars: Math.round(chars),
                  embeddingModel: embedding.trim(),
                },
              })
            }
          >
            <Save aria-hidden /> Speichern
          </Button>
          <Button variant="outline" onClick={() => void runTest()} disabled={testing || !baseUrl.trim()} data-testid="settings-test-connection">
            {testing ? <Loader2 className="animate-spin" aria-hidden /> : <PlugZap aria-hidden />} Verbindung testen
          </Button>
        </div>
        {test && (
          <Notice
            tone={test.ok ? 'info' : 'danger'}
            title={test.ok ? 'Verbindung erfolgreich' : 'Verbindung fehlgeschlagen'}
            data-testid="settings-test-result"
          >
            <p>{test.message}</p>
            {test.latencyMs !== null && <p className="mt-1 text-xs">Antwortzeit: {test.latencyMs} ms</p>}
            {test.modelReply && <p className="mt-1 text-xs">Antwort des Modells: „{test.modelReply}“</p>}
            {!test.ok && test.error && <p className="mt-1 text-xs">{test.error.message}</p>}
          </Notice>
        )}
      </Section>

      <Section title="API-Schlüssel" description="Der Schlüssel wird verschlüsselt auf diesem Computer gespeichert und nie wieder angezeigt.">
        <div className="flex items-center gap-2 text-sm">
          <KeyRound className="size-4 text-muted-foreground" aria-hidden />
          {hasApiKey ? <Badge variant="success">Schlüssel gespeichert</Badge> : <Badge variant="warning">Kein Schlüssel gespeichert</Badge>}
        </div>
        <Field label={hasApiKey ? 'Neuen Schlüssel eintragen (ersetzt den alten)' : 'Schlüssel eintragen'} htmlFor="s-apikey">
          <Input id="s-apikey" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" data-testid="settings-apikey" />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={keyBusy || !apiKey.trim()}
            data-testid="settings-apikey-save"
            onClick={async () => {
              const ok = await run(() => call('settings:setApiKey', { apiKey: apiKey.trim() }), { success: 'API-Schlüssel gespeichert.' });
              if (ok) {
                setApiKey('');
                reload();
              }
            }}
          >
            Schlüssel speichern
          </Button>
          {hasApiKey && (
            <Button variant="ghost" onClick={() => setClearOpen(true)} data-testid="settings-apikey-clear">
              <Trash2 aria-hidden /> Schlüssel löschen
            </Button>
          )}
        </div>
      </Section>

      <ConfirmDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        title="API-Schlüssel löschen?"
        description="Ohne Schlüssel kann Archivist keine KI-Funktionen mehr nutzen, bis Sie einen neuen eintragen."
        confirmLabel="Schlüssel löschen"
        destructive
        onConfirm={async () => {
          const ok = await run(() => call('settings:clearApiKey'), { success: 'API-Schlüssel gelöscht.' });
          if (ok) {
            setClearOpen(false);
            reload();
          }
        }}
      />
    </div>
  );
}
