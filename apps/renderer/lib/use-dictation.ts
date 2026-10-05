'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { SPEECH_MAX_SECONDS } from '@archivist/shared';
import { describeMicrophoneError } from './dictation';
import { call } from './ipc';
import { startRecorder, type Recorder } from './recorder';
import { useToast } from './toast';

export type DictationState = 'idle' | 'recording' | 'transcribing';

/** Speech input: records on request, turns the recording into text on this machine and hands the text to `onText`. */
export function useDictation({ onText }: { onText: (text: string) => void }) {
  const { toast, reportError } = useToast();
  const [state, setState] = useState<DictationState>('idle');
  const [seconds, setSeconds] = useState(0);
  const recorder = useRef<Recorder | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const finish = useCallback(async () => {
    const active = recorder.current;
    if (!active) return;
    recorder.current = null;
    setState('transcribing');
    try {
      const { text } = await call('speech:transcribe', { audio: await active.stop() });
      if (text) onTextRef.current(text);
      else toast({ title: 'Ich habe nichts verstanden', description: 'Sprich etwas lauter oder näher am Mikrofon und versuche es noch einmal.' });
    } catch (err) {
      reportError(err, undefined, 'Die Aufnahme konnte nicht in Text umgewandelt werden');
    } finally {
      setState('idle');
    }
  }, [toast, reportError]);

  const start = useCallback(async () => {
    try {
      recorder.current = await startRecorder();
      setSeconds(0);
      setState('recording');
    } catch (err) {
      toast({ variant: 'error', title: 'Mikrofon nicht verfügbar', description: describeMicrophoneError(err) });
    }
  }, [toast]);

  const cancel = useCallback(() => {
    recorder.current?.cancel();
    recorder.current = null;
    setState('idle');
  }, []);

  useEffect(() => {
    if (state !== 'recording') return undefined;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      setSeconds(elapsed);
      if (elapsed >= SPEECH_MAX_SECONDS) void finish();
    }, 250);
    return () => clearInterval(timer);
  }, [state, finish]);

  // leaving the page ends the recording and releases the microphone
  useEffect(() => () => recorder.current?.cancel(), []);

  return { state, seconds, start, finish, cancel };
}
