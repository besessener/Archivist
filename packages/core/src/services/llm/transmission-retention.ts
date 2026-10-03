/** How long the transmission log keeps an entry; older ones are deleted at startup and then daily. */
export const TRANSMISSION_RETENTION_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO timestamp before which entries are too old (entries store `at` as ISO strings, which sort like time). */
export function retentionCutoff(now: Date, days: number = TRANSMISSION_RETENTION_DAYS): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}
