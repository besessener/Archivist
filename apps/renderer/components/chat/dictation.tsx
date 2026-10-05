'use client';

import { useState } from 'react';
import { Loader2, Mic, Square } from 'lucide-react';
import { SPEECH_MAX_SECONDS, type SpeechStatus } from '@archivist/shared';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { formatDuration } from '@/lib/dictation';
import { formatBytes } from '@/lib/format';
import { call } from '@/lib/ipc';
import { useRun } from '@/lib/use-run';
import type { DictationState } from '@/lib/use-dictation';

export interface DictationProps {
  status: SpeechStatus | undefined;
  state: DictationState;
  seconds: number;
  onStart: () => void;
  onFinish: () => void;
  onCancel: () => void;
}

function buttonLabel({ status, state, seconds }: { status: SpeechStatus; state: DictationState; seconds: number }): string {
  if (state === 'recording') return `Aufnahme beenden und in Text umwandeln (${formatDuration(seconds)})`;
  if (state === 'transcribing') return 'Aufnahme wird in Text umgewandelt';
  if (status.state === 'downloading') return 'Spracheingabe wird eingerichtet';
  return status.state === 'not_installed' ? 'Spracheingabe einrichten' : 'Spracheingabe starten';
}

/** The microphone button of the chat input: sets the speech input up on first use, then starts and ends a recording. */
export function DictationButton({ status, state, seconds, onStart, onFinish, onCancel }: DictationProps) {
  const [setupOpen, setSetupOpen] = useState(false);
  const { run } = useRun();
  if (!status || status.state === 'unavailable') return null;

  const busy = status.state === 'downloading' || state === 'transcribing';
  const recording = state === 'recording';
  const label = buttonLabel({ status, state, seconds });

  function press() {
    if (recording) onFinish();
    else if (status?.state === 'not_installed') setSetupOpen(true);
    else onStart();
  }

  return (
    <>
      <Button
        type="button"
        variant={recording ? 'destructive' : 'ghost'}
        size="icon"
        aria-label={label}
        aria-pressed={recording}
        title={label}
        disabled={busy}
        data-testid="dictation-toggle"
        data-state={status.state === 'ready' ? state : status.state}
        onClick={press}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && recording) onCancel();
        }}
      >
        {busy ? <Loader2 className="animate-spin" aria-hidden /> : recording ? <Square aria-hidden /> : <Mic aria-hidden />}
      </Button>
      <ConfirmDialog
        open={setupOpen}
        onOpenChange={setSetupOpen}
        title="Spracheingabe einrichten"
        description={
          <>
            Archivist lädt einmalig das Spracherkennungsmodell „{status.modelLabel}“ ({formatBytes(status.totalBytes)}) von huggingface.co herunter. Danach
            läuft die Spracheingabe vollständig auf deinem Rechner: Aufnahmen werden weder gespeichert noch an ein LLM oder einen anderen Dienst gesendet.
          </>
        }
        confirmLabel="Herunterladen"
        confirmTestId="dictation-install-confirm"
        onConfirm={async () => {
          await run(() => call('speech:install', { confirmed: true }), { errorTitle: 'Der Download konnte nicht gestartet werden' });
          setSetupOpen(false);
        }}
      />
    </>
  );
}

/** What the speech input is doing right now, below the input field; the recording and the download can be stopped here. */
export function DictationNote({ status, state, seconds, onCancel }: Omit<DictationProps, 'onStart' | 'onFinish'>) {
  const { run } = useRun();
  const downloading = status?.state === 'downloading';
  const percent = status && status.totalBytes > 0 ? Math.round((status.receivedBytes / status.totalBytes) * 100) : 0;
  const message =
    state === 'recording'
      ? `Aufnahme läuft … ${formatDuration(seconds)} von höchstens ${formatDuration(SPEECH_MAX_SECONDS)}. Klicke noch einmal auf das Mikrofon, um sie zu beenden.`
      : state === 'transcribing'
        ? 'Die Aufnahme wird in Text umgewandelt …'
        : '';

  return (
    <div className="mx-auto mt-1.5 flex max-w-3xl 2xl:max-w-5xl flex-col gap-1 text-xs text-muted-foreground" data-testid="dictation-note">
      <div role="status" className="flex items-center justify-center gap-2" data-testid="dictation-status">
        {message}
        {state === 'recording' && (
          <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={onCancel} data-testid="dictation-discard">
            Verwerfen
          </Button>
        )}
      </div>
      {downloading && (
        <div className="flex items-center justify-center gap-2" data-testid="dictation-download">
          <span>
            Spracherkennung wird heruntergeladen … {formatBytes(status.receivedBytes)} von {formatBytes(status.totalBytes)}
          </span>
          <Progress value={percent} className="h-1.5 w-32" aria-label="Fortschritt des Downloads" />
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={() => void run(() => call('speech:cancelInstall'))}
            data-testid="dictation-download-cancel"
          >
            Abbrechen
          </Button>
        </div>
      )}
      {status?.error && !downloading && (
        <p className="text-center text-destructive" data-testid="dictation-error">
          {status.error}
        </p>
      )}
    </div>
  );
}
