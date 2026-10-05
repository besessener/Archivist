/** Averages the channels of a recording into one. */
export function mixToMono(channels: Float32Array[]): Float32Array {
  const first = channels[0];
  if (!first) return new Float32Array(0);
  if (channels.length === 1) return first;
  const mono = new Float32Array(first.length);
  for (const channel of channels) for (let i = 0; i < mono.length; i++) mono[i] = mono[i]! + (channel[i] ?? 0) / channels.length;
  return mono;
}

export function toInt16(samples: Float32Array): Int16Array<ArrayBuffer> {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) pcm[i] = Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32_767);
  return pcm;
}

/** `75` → `1:15`. */
export function formatDuration(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** Dictated text joins the text already in the input field with one space; the field keeps what the user typed. */
export function joinDictation(current: string, dictated: string): string {
  if (current.trim() === '') return dictated;
  return `${current.trimEnd()} ${dictated}`;
}

/** What the browser says when the microphone cannot be used, in words that tell the user what to do. */
export function describeMicrophoneError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return 'Es wurde kein Mikrofon gefunden. Schließe eins an oder wähle in Windows ein Standard-Mikrofon.';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Archivist darf das Mikrofon nicht benutzen. Prüfe unter Windows → Einstellungen → Datenschutz & Sicherheit → Mikrofon, ob Desktop-Apps zugreifen dürfen.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'Das Mikrofon ist gerade nicht erreichbar, vielleicht nutzt es ein anderes Programm.';
  return 'Die Aufnahme konnte nicht gestartet werden.';
}
