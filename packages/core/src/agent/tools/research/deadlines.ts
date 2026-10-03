import { truncate } from '../../../util/text';
import { addPeriod, findDates, formatGermanDate, twoDigits, type PeriodUnit } from './dates';

export type DeadlineKind = 'kuendigung' | 'garantie' | 'ausweis' | 'versicherung' | 'tuev' | 'widerspruch' | 'ablauf' | 'faelligkeit';

export const DEADLINE_LABEL: Record<DeadlineKind, string> = {
  kuendigung: 'Kündigungsfrist',
  garantie: 'Garantie/Gewährleistung',
  ausweis: 'Ausweis/Dokument läuft ab',
  versicherung: 'Versicherung',
  tuev: 'TÜV/Hauptuntersuchung',
  widerspruch: 'Widerspruchs-/Widerrufsfrist',
  ablauf: 'Ablauf/Vertragsende',
  faelligkeit: 'Fälligkeit',
};

export const DEADLINE_KINDS = Object.keys(DEADLINE_LABEL) as [DeadlineKind, ...DeadlineKind[]];

export interface Deadline {
  kind: DeadlineKind;
  /** YYYY-MM-DD; null when the reference date is missing */
  date: string | null;
  evidence: string;
  /** Computation path in plain language („Vertragsende 31.12.2026 − 3 Monate = 30.09.2026“). */
  rechenweg: string;
  past: boolean;
}

type FoundDeadline = Omit<Deadline, 'past'>;
type KeywordKind = DeadlineKind | 'gueltig' | 'ende';

/** Keywords right before a date, the closest one wins. */
const DATE_KEYWORDS: Array<{ re: RegExp; kind: KeywordKind }> = [
  { re: /\b(?:tüv|tuev|hu|hauptuntersuchung)\b/gi, kind: 'tuev' },
  { re: /kündbar|kündigung|kuendigung/gi, kind: 'kuendigung' },
  { re: /garantie|gewährleistung/gi, kind: 'garantie' },
  { re: /widerspruch|widerruf|einspruch/gi, kind: 'widerspruch' },
  { re: /fällig|faellig|zahlbar\s+bis|zahlungsziel|zu\s+zahlen\s+bis/gi, kind: 'faelligkeit' },
  { re: /gültig\s+bis|gueltig\s+bis|gültigkeit|valid\s+until|expires?/gi, kind: 'gueltig' },
  { re: /ablauf|läuft\s+ab|laeuft\s+ab|endet\s+am|endet\s+zum|vertragsende|laufzeit\s+bis|laufzeitende|befristet\s+bis/gi, kind: 'ende' },
];

const NUMBER_WORDS: Record<string, number> = {
  ein: 1,
  eine: 1,
  einem: 1,
  einen: 1,
  einer: 1,
  zwei: 2,
  drei: 3,
  vier: 4,
  fünf: 5,
  sechs: 6,
  acht: 8,
  zehn: 10,
  zwölf: 12,
  vierzehn: 14,
};
const toNumber = (word: string) => (/^\d+$/.test(word) ? Number(word) : (NUMBER_WORDS[word.toLowerCase()] ?? null));
const unitOf = (word: string): PeriodUnit => (/^tag/i.test(word) ? 'tag' : /^woche/i.test(word) ? 'woche' : /^jahr/i.test(word) ? 'jahr' : 'monat');
const UNIT_LABEL: Record<PeriodUnit, [string, string]> = {
  tag: ['Tag', 'Tage'],
  woche: ['Woche', 'Wochen'],
  monat: ['Monat', 'Monate'],
  jahr: ['Jahr', 'Jahre'],
};
const periodText = (count: number, unit: PeriodUnit) => `${count} ${UNIT_LABEL[unit][count === 1 ? 0 : 1]}`;
const COUNT = String.raw`(\d{1,3}|ein|eine|einem|einen|einer|zwei|drei|vier|fünf|sechs|acht|zehn|zwölf|vierzehn)`;
const UNIT = String.raw`(tag|tage|tagen|woche|wochen|monat|monate|monaten|jahr|jahre|jahren)`;

/** Notice period before an end date („Kündigungsfrist 3 Monate zum Vertragsende 31.12.2026“). */
const NOTICE_RE = new RegExp(
  String.raw`(?:kündigungsfrist|kuendigungsfrist|frist)(?::|\s(?:von|beträgt|betraegt))?\s{1,3}${COUNT}\s${UNIT}\s(?:zum|vor|bis\szum)\b([^\n]{0,80})`,
  'gi',
);

/** Periods counted from the document date. */
const RELATIVE_PERIODS: Array<{ re: RegExp; kind: DeadlineKind }> = [
  { re: new RegExp(String.raw`(?:widerspruch|widerruf|einspruch)[^\n.]{0,60}?innerhalb\s(?:von\s)?${COUNT}\s${UNIT}`, 'gi'), kind: 'widerspruch' },
  { re: new RegExp(String.raw`innerhalb\s(?:von\s)?${COUNT}\s${UNIT}[^\n.]{0,60}?(?:widerspruch|widerruf|einspruch)`, 'gi'), kind: 'widerspruch' },
  {
    re: new RegExp(String.raw`(?:garantie|gewährleistung|herstellergarantie)(?::|\s(?:von|beträgt|betraegt))?\s{1,3}${COUNT}\s${UNIT}`, 'gi'),
    kind: 'garantie',
  },
  { re: new RegExp(String.raw`${COUNT}\s${UNIT}\s(?:herstellergarantie|garantie|gewährleistung)`, 'gi'), kind: 'garantie' },
  { re: new RegExp(String.raw`zahlbar\sinnerhalb\s(?:von\s)?${COUNT}\s${UNIT}`, 'gi'), kind: 'faelligkeit' },
];

function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return truncate(
    text
      .slice(start, end < 0 ? text.length : end)
      .replace(/\s+/g, ' ')
      .trim(),
    220,
  );
}

function keywordBefore(text: string, index: number): KeywordKind | null {
  const lineStart = text.lastIndexOf('\n', index) + 1;
  const before = text.slice(Math.max(lineStart, index - 70), index);
  let found: { kind: KeywordKind; position: number } | null = null;
  for (const keyword of DATE_KEYWORDS)
    for (const m of before.matchAll(keyword.re)) if (!found || m.index > found.position) found = { kind: keyword.kind, position: m.index };
  return found?.kind ?? null;
}

interface DocumentKind {
  isId: boolean;
  isInsurance: boolean;
}

const expiryKind = (document: DocumentKind): DeadlineKind => (document.isInsurance ? 'versicherung' : 'ablauf');

function deadlineKind(keyword: KeywordKind, document: DocumentKind): DeadlineKind {
  if (keyword === 'gueltig') return document.isId ? 'ausweis' : expiryKind(document);
  if (keyword === 'ende') return expiryKind(document);
  return keyword;
}

/** Absolute dates near a keyword, and the contract end among them. */
function keywordDeadlines(text: string): { deadlines: FoundDeadline[]; contractEnd: string | null } {
  const lowerText = text.toLowerCase();
  const document = {
    isId: /personalausweis|reisepass|\bausweis|führerschein|aufenthaltstitel|\bpass\b/.test(lowerText),
    isInsurance: /versicherung|police|versicherungsschein/.test(lowerText),
  };
  const deadlines: FoundDeadline[] = [];
  let contractEnd: string | null = null;
  for (const hit of findDates(text)) {
    const keyword = keywordBefore(text, hit.index);
    if (!keyword) continue;
    if (keyword === 'ende' && !contractEnd) contractEnd = hit.iso;
    deadlines.push({
      kind: deadlineKind(keyword, document),
      date: hit.iso,
      evidence: lineAt(text, hit.index),
      rechenweg: `Datum steht im Text${hit.monthOnly ? ' (Monat/Jahr → Monatsende)' : ''}: ${formatGermanDate(hit.iso)}`,
    });
  }
  return { deadlines, contractEnd };
}

function noticeDeadline(match: RegExpExecArray, source: { text: string; contractEnd: string | null }): FoundDeadline | null {
  const count = toNumber(match[1]!);
  if (!count) return null;
  const unit = unitOf(match[2]!);
  const tail = match[3] ?? '';
  const end = findDates(tail)[0]?.iso ?? (/vertragsende|ablauf|laufzeit|ende/i.test(tail) ? source.contractEnd : null);
  const endLabel = /vertragsende/i.test(tail) ? 'Vertragsende' : /ablauf/i.test(tail) ? 'Ablauf' : 'Stichtag';
  const evidence = lineAt(source.text, match.index);
  if (!end)
    return { kind: 'kuendigung', date: null, evidence, rechenweg: `${periodText(count, unit)} vor dem ${endLabel} – das Datum dafür steht nicht im Text` };
  const date = addPeriod(end, { count: -count, unit });
  return {
    kind: 'kuendigung',
    date,
    evidence,
    rechenweg: `${endLabel} ${formatGermanDate(end)} − ${periodText(count, unit)} = ${formatGermanDate(date)} (Kündigung muss spätestens dann zugehen)`,
  };
}

interface PeriodBase {
  baseDate: string | null;
  baseLabel: string;
}

function relativeDeadline(match: RegExpExecArray, source: PeriodBase & { text: string; kind: DeadlineKind }): FoundDeadline | null {
  const count = toNumber(match[1]!);
  if (!count) return null;
  const unit = unitOf(match[2]!);
  const { kind, baseDate, baseLabel } = source;
  const evidence = lineAt(source.text, match.index);
  if (!baseDate) return { kind, date: null, evidence, rechenweg: `${periodText(count, unit)} ab ${baseLabel} – das ${baseLabel} ist unbekannt` };
  const date = addPeriod(baseDate, { count, unit });
  return { kind, date, evidence, rechenweg: `${baseLabel} ${formatGermanDate(baseDate)} + ${periodText(count, unit)} = ${formatGermanDate(date)}` };
}

function relativeDeadlines(text: string, base: PeriodBase): FoundDeadline[] {
  const deadlines: FoundDeadline[] = [];
  for (const { re, kind } of RELATIVE_PERIODS)
    for (const match of text.matchAll(re)) {
      const deadline = relativeDeadline(match, { ...base, text, kind });
      if (deadline) deadlines.push(deadline);
    }
  return deadlines;
}

export interface DeadlineOptions {
  /** Relative periods („Garantie 24 Monate“) count from this date, usually the document date. */
  baseDate: string | null;
  today: Date;
  baseLabel?: string;
}

/** Deadlines and expiry dates in a document text, each with the passage and the computation path. */
export function findDeadlines(text: string, { baseDate, today, baseLabel = 'Dokumentdatum' }: DeadlineOptions): Deadline[] {
  const todayIso = `${today.getFullYear()}-${twoDigits(today.getMonth() + 1)}-${twoDigits(today.getDate())}`;
  const keyword = keywordDeadlines(text);
  const notices = [...text.matchAll(NOTICE_RE)].flatMap((m) => noticeDeadline(m, { text, contractEnd: keyword.contractEnd }) ?? []);
  const deadlines: Deadline[] = [];
  for (const found of [...keyword.deadlines, ...notices, ...relativeDeadlines(text, { baseDate, baseLabel })]) {
    if (deadlines.some((d) => d.kind === found.kind && d.date === found.date)) continue;
    deadlines.push({ ...found, past: found.date !== null && found.date < todayIso });
  }
  return deadlines.toSorted((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));
}
