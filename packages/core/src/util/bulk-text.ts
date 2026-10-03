const MS_PER_MINUTE = 60_000;
const MIN_SAMPLES = 3;
const number = (value: number): string => value.toLocaleString('de-DE');

/** „ca. 2 Std. 5 Min.“ for a remaining time in milliseconds; „weniger als 1 Min.“ below a minute. */
export function formatRemaining(ms: number): string {
  const minutes = Math.round(ms / MS_PER_MINUTE);
  if (minutes < 1) return 'weniger als 1 Min.';
  if (minutes < 60) return `ca. ${minutes} Min.`;
  const rest = minutes % 60;
  return `ca. ${Math.floor(minutes / 60)} Std.${rest ? ` ${rest} Min.` : ''}`;
}

/** „4.300 von 20.000 analysiert, ca. 2 Std. 5 Min. verbleibend“; `sampled` items finished within `elapsedMs` (a resumed run counts only its own). */
export function progressLine(progress: { done: number; total: number; elapsedMs: number; sampled?: number; verb?: string }): string {
  const { done, total, elapsedMs, sampled = done, verb = 'analysiert' } = progress;
  const line = `${number(done)} von ${number(total)} ${verb}`;
  if (sampled < MIN_SAMPLES || done >= total || elapsedMs <= 0) return line;
  return `${line}, ${formatRemaining(((total - done) * elapsedMs) / sampled)} verbleibend`;
}

/** „12 Dokumente analysiert, 2 Fehler“ – the text of the one notification of a bulk run. */
export function runSummary(result: { done: number; failed: number; verb?: string }): string {
  const { done, failed, verb = 'analysiert' } = result;
  return `${number(done)} ${done === 1 ? 'Dokument' : 'Dokumente'} ${verb}, ${number(failed)} Fehler`;
}

/** The notification text of a bulk run that waits because the daily token limit is reached; the rest stays untouched. */
export function tokenCapPauseText(progress: { done: number; total: number; verb?: string }): string {
  const { done, total, verb = 'analysiert' } = progress;
  return `Das Tageslimit für Tokens ist erreicht. ${number(done)} von ${number(total)} ${verb}; der Rest bleibt unverändert und wird morgen fortgesetzt, spätestens sobald du das Limit erhöhst.`;
}
