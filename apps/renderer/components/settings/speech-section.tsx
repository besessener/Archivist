'use client';

import { useState } from 'react';
import { Download, Trash2 } from 'lucide-react';
import { SPEECH_MODEL_NAMES, type SpeechModelName, type SpeechStatus } from '@archivist/shared';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { Field } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Select } from '@/components/ui/select';
import { formatBytes } from '@/lib/format';
import { call } from '@/lib/ipc';
import { useQuery } from '@/lib/use-query';
import { useRun } from '@/lib/use-run';
import { Section, useSaveSettings, type TabProps } from './shared';

const STATE_TEXT: Record<SpeechStatus['state'], string> = {
  unavailable: 'in dieser Version nicht verfügbar',
  not_installed: 'nicht heruntergeladen',
  downloading: 'wird heruntergeladen …',
  ready: 'heruntergeladen',
};

type ModelRow = SpeechStatus['models'][number];

const sizeText = (model: ModelRow) => (model.totalBytes > 0 ? ` (${formatBytes(model.totalBytes)})` : '');

/** The Whisper model of the speech input: choose from the fixed list, download the chosen one, delete downloaded ones. */
export function SpeechSection({ settings, reload }: Pick<TabProps, 'settings' | 'reload'>) {
  const status = useQuery('speech:status', {}, { scopes: ['speech', 'settings'] });
  const { save, busy } = useSaveSettings(reload);
  const { run } = useRun();
  const [removing, setRemoving] = useState<ModelRow | null>(null);
  const models = status.data?.models ?? [];
  const selected = status.data?.selected ?? settings.speech.model;
  const downloading = status.data?.state === 'downloading';
  const percent = status.data && status.data.totalBytes > 0 ? Math.round((status.data.receivedBytes / status.data.totalBytes) * 100) : 0;
  const choose = (name: SpeechModelName) => void save({ speech: { model: name } });

  return (
    <Section
      title="Spracheingabe"
      description="Das Mikrofon im Chat wandelt deine Sprache lokal in Text um. Größere Modelle erkennen Namen und Fachbegriffe besser, brauchen aber mehr Platz und länger. Aufnahmen werden nie gespeichert oder gesendet."
    >
      <Field label="Modell" htmlFor="speech-model">
        <Select
          id="speech-model"
          value={selected}
          disabled={busy || models.length === 0}
          onChange={(e) => choose(e.target.value as SpeechModelName)}
          data-testid="settings-speech-model"
        >
          {SPEECH_MODEL_NAMES.map((name) => {
            const model = models.find((candidate) => candidate.name === name);
            return (
              <option key={name} value={name} disabled={model?.state === 'unavailable'}>
                {model ? `${model.label}${sizeText(model)}` : name}
              </option>
            );
          })}
        </Select>
      </Field>

      <ul className="flex flex-col gap-2" data-testid="settings-speech-models">
        {models.map((model) => (
          <li key={model.name} className="flex flex-wrap items-center justify-between gap-2 text-sm" data-testid={`settings-speech-row-${model.name}`}>
            <span>
              {model.label}
              {sizeText(model)}: <span data-testid={`settings-speech-state-${model.name}`}>{STATE_TEXT[model.state]}</span>
            </span>
            {model.state === 'ready' && (
              <Button variant="outline" size="sm" onClick={() => setRemoving(model)} data-testid={`settings-speech-remove-${model.name}`}>
                <Trash2 aria-hidden /> Löschen
              </Button>
            )}
          </li>
        ))}
      </ul>

      {status.data?.state === 'not_installed' && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Das gewählte Modell lädt Archivist einmalig von huggingface.co herunter. Dabei gehen keine Daten von dir hinaus; im Datenschutzmodus „nur lokal“ ist
            der Download gesperrt.
          </p>
          <div>
            <Button
              variant="outline"
              onClick={() => void run(() => call('speech:install', { confirmed: true }), { errorTitle: 'Der Download konnte nicht gestartet werden' })}
              data-testid="settings-speech-install"
            >
              <Download aria-hidden /> Herunterladen
            </Button>
          </div>
        </div>
      )}
      {downloading && status.data && (
        <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="settings-speech-download">
          <span>
            {formatBytes(status.data.receivedBytes)} von {formatBytes(status.data.totalBytes)}
          </span>
          <Progress value={percent} className="h-1.5 w-40" aria-label="Fortschritt des Downloads" />
          <Button variant="outline" size="sm" onClick={() => void run(() => call('speech:cancelInstall'))} data-testid="settings-speech-cancel">
            Abbrechen
          </Button>
        </div>
      )}
      {status.data?.error && !downloading && (
        <p className="text-sm text-destructive" data-testid="settings-speech-error">
          {status.data.error}
        </p>
      )}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Modell löschen?"
        description={
          removing
            ? `${removing.label} wird von diesem Rechner gelöscht und gibt ${formatBytes(removing.totalBytes)} frei. Du kannst es später erneut herunterladen.`
            : ''
        }
        confirmLabel="Löschen"
        confirmTestId="settings-speech-remove-confirm"
        destructive
        onConfirm={async () => {
          if (removing)
            await run(() => call('speech:remove', { model: removing.name, confirmed: true }), { errorTitle: 'Das Modell konnte nicht gelöscht werden' });
          setRemoving(null);
        }}
      />
    </Section>
  );
}
