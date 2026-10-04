const dateFormat = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const dateTimeFormat = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const longDateFormat = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });

function parse(value: string | null | undefined): Date | null {
  if (!value) return null;
  // interpret plain date values as local days (no time zone shift)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const parsed = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatDate(value: string | null | undefined, fallback = '–'): string {
  const parsed = parse(value);
  return parsed ? dateFormat.format(parsed) : fallback;
}

export function formatLongDate(value: string | null | undefined, fallback = '–'): string {
  const parsed = parse(value);
  return parsed ? longDateFormat.format(parsed) : fallback;
}

export function formatDateTime(value: string | null | undefined, fallback = '–'): string {
  const parsed = parse(value);
  return parsed ? dateTimeFormat.format(parsed) : fallback;
}

/** An estimate in words, never as a percentage: the values are self-reports of the AI or rules, not measured (#167). */
export function confidenceWord(value: number): string {
  if (value >= 0.8) return 'eher sicher';
  if (value >= 0.5) return 'unsicher';
  return 'sehr unsicher';
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '–';
  if (bytes < 1024) return `${bytes} Byte`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: value < 10 ? 1 : 0 }).format(value)} ${units[i]}`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('de-DE').format(value);
}

export function relativeDay(value: string | null | undefined): string {
  const parsed = parse(value);
  if (!parsed) return '–';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(parsed);
  target.setHours(0, 0, 0, 0);
  const diff = Math.round((target.getTime() - today.getTime()) / 86400000);
  if (diff === 0) return 'heute';
  if (diff === 1) return 'morgen';
  if (diff === -1) return 'gestern';
  if (diff > 1) return `in ${diff} Tagen`;
  return `vor ${-diff} Tagen`;
}

/** „1 Eintrag“, „3 Einträge“: the count with its singular or plural noun. */
export function plural(count: number, [one, many]: readonly [string, string]): string {
  return `${formatNumber(count)} ${count === 1 ? one : many}`;
}
