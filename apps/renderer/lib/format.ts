const dateFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const longDateFmt = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });

function parse(value: string | null | undefined): Date | null {
  if (!value) return null;
  // interpret plain date values as local days (no time zone shift)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDate(value: string | null | undefined, fallback = '–'): string {
  const d = parse(value);
  return d ? dateFmt.format(d) : fallback;
}

export function formatLongDate(value: string | null | undefined, fallback = '–'): string {
  const d = parse(value);
  return d ? longDateFmt.format(d) : fallback;
}

export function formatDateTime(value: string | null | undefined, fallback = '–'): string {
  const d = parse(value);
  return d ? dateTimeFmt.format(d) : fallback;
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '–';
  return `${Math.round(value * 100)} %`;
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
  const d = parse(value);
  if (!d) return '–';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  const diff = Math.round((target.getTime() - today.getTime()) / 86400000);
  if (diff === 0) return 'heute';
  if (diff === 1) return 'morgen';
  if (diff === -1) return 'gestern';
  if (diff > 1) return `in ${diff} Tagen`;
  return `vor ${-diff} Tagen`;
}

export function plural(n: number, one: string, many: string): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}
