import { z } from 'zod';
import type { DocumentRecord } from '@archivist/shared';
import { MIME_BY_EXT } from '../../parsers';
import { redactSecrets } from '../../util/redact';
import { nameSimilarity, truncate } from '../../util/text';
import { folderLabel, folderOf } from '../../services/archive-structure';
import { defineTool, list, type AgentTool, type ToolContext } from '../registry';
import { asData } from '../security';
import { ARCHIVED, allDocs, docDay, docLine, lower, resolveDocs, unknownNote, type ToolDeps } from './common';

/**
 * Research tools (#309, #310, #312): sums, gaps, comparisons, deadlines, secrets, problem files, storage, mail threads,
 * payment matching and filing examples. Everything is computed here, deterministically – the model only reads the result.
 */

// ---------- money ----------
/** A number as written in a document: „1.234,56“, „1,234.56“, „99,00“, „12.50“, „1.234“ (thousands). */
export function parseNumber(raw: string): number | null {
  let s = raw.replace(/[\s'\u00a0\u202f]/g, '');
  const neg = s.startsWith('-') || s.startsWith('−');
  s = s.replace(/^[-+−]/, '');
  if (!/^\d[\d.,]*$/.test(s)) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let intPart = s;
  let frac = '';
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = Math.max(lastDot, lastComma);
    intPart = s.slice(0, dec);
    frac = s.slice(dec + 1);
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? ',' : '.';
    const idx = s.lastIndexOf(sep);
    const tail = s.slice(idx + 1);
    // exactly three digits after a single separator: thousands („1.234“); otherwise decimals
    if (tail.length === 3 && s.indexOf(sep) === idx) intPart = s.replace(sep, '');
    else if (tail.length === 3) intPart = s.split(sep).join('');
    else {
      intPart = s.slice(0, idx);
      frac = tail;
    }
  }
  intPart = intPart.replace(/[.,]/g, '');
  if (!/^\d+$/.test(intPart) || !/^\d{0,2}$/.test(frac)) return null;
  const value = Number(`${intPart}.${frac || '0'}`);
  return Number.isFinite(value) ? (neg ? -value : value) : null;
}

/** Shorthand for tests and callers: one money string → value („1.234,56 €“ → 1234.56). */
export function parseAmount(text: string): number | null {
  return findAmounts(text)[0]?.value ?? null;
}

const NUM = String.raw`[-−]?\d{1,3}(?:[.,'\u00a0 ]\d{3})+(?:[.,]\d{1,2})?|[-−]?\d+(?:[.,]\d{1,2})?`;
const MONEY_RE = new RegExp(String.raw`(?:€|\bEUR\b)\s?(${NUM})|(${NUM})\s?(?:€|EUR\b)`, 'gi');
const PLAIN_DECIMAL_RE = /(?<![\d.,])[-−]?\d{1,3}(?:\.\d{3})*,\d{2}(?![\d,])|(?<![\d.,])[-−]?\d+\.\d{2}(?![\d.])/g;

/** Money amounts with currency (€/EUR) in a text, in order. */
export function findAmounts(text: string): Array<{ value: number; raw: string }> {
  const out: Array<{ value: number; raw: string }> = [];
  for (const m of text.matchAll(MONEY_RE)) {
    const value = parseNumber(m[1] ?? m[2] ?? '');
    if (value !== null) out.push({ value, raw: m[0].trim() });
  }
  return out;
}

const STRONG_TOTAL_RE = /gesamt|rechnungsbetrag|endbetrag|zu\s+zahlen|\btotal\b|bruttobetrag|zahlbetrag|amount\s+due/i;
const WEAK_TOTAL_RE = /summe|betrag/i;
const NOT_TOTAL_RE = /zwischensumme|netto|subtotal|mwst|ust\b|umsatzsteuer|steuer|rabatt|skonto|bereits\s+bezahlt/i;

/** Invoice total of a text: preferably a line with Gesamt/Summe/Total …, otherwise the largest amount. */
export function invoiceTotal(text: string): { amount: number; line: string } | null {
  let best: { amount: number; line: string; score: number } | null = null;
  let largest: { amount: number; line: string } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let amounts = findAmounts(line).map((a) => a.value);
    const strong = STRONG_TOTAL_RE.test(line);
    const weak = WEAK_TOTAL_RE.test(line);
    if (!amounts.length && (strong || weak)) amounts = [...line.matchAll(PLAIN_DECIMAL_RE)].map((m) => parseNumber(m[0]) ?? 0);
    const positive = amounts.filter((a) => a > 0);
    if (!positive.length) continue;
    const max = Math.max(...positive);
    if (!largest || max > largest.amount) largest = { amount: max, line };
    const score = (strong ? 2 : weak ? 1 : 0) - (NOT_TOTAL_RE.test(line) && !/gesamt|brutto/i.test(line) ? 2 : 0);
    if (score > 0 && (!best || score > best.score || (score === best.score && max >= best.amount))) best = { amount: max, line, score };
  }
  if (best) return { amount: best.amount, line: best.line };
  return largest;
}

/** 1234.56 → „1.234,56 €“ (deterministic, without locale data). */
export function formatEuro(value: number): string {
  const cents = Math.round(Math.abs(value) * 100);
  const digits = String(Math.floor(cents / 100));
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= 3) groups.unshift(digits.slice(Math.max(0, end - 3), end));
  const int = groups.join('.');
  return `${value < 0 ? '-' : ''}${int},${String(cents % 100).padStart(2, '0')} €`;
}

/** Exact sum via cents. */
export const sumAmounts = (values: number[]) => values.reduce((s, v) => s + Math.round(v * 100), 0) / 100;

// ---------- gaps ----------
const monthIndex = (ym: string) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
const monthKey = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;

/** Months (YYYY-MM) present between the first and last date, and the missing ones. */
export function monthGaps(days: string[]): { first: string | null; last: string | null; present: string[]; missing: string[] } {
  const months = [...new Set(days.filter((d) => /^\d{4}-\d{2}/.test(d)).map((d) => d.slice(0, 7)))].toSorted();
  if (!months.length) return { first: null, last: null, present: [], missing: [] };
  const have = new Set(months);
  const missing: string[] = [];
  for (let i = monthIndex(months[0]!); i <= monthIndex(months.at(-1)!) && missing.length < 600; i += 1) if (!have.has(monthKey(i))) missing.push(monthKey(i));
  return { first: months[0]!, last: months.at(-1)!, present: months, missing };
}

/** Sequence number in a name: „Nr. 12“, „Auszug 3“, „#7“ (number) or „2025-07“ (month). */
export function sequenceNumber(name: string): { kind: 'number'; n: number } | { kind: 'month'; month: string } | null {
  const labelled = /(?:\bnr|\bno|\bnummer|\bauszug|\bkontoauszug|\bteil|\bheft|\bausgabe|\brechnung|#)\.?\s?[:#]?\s?(\d{1,6})\b/i.exec(name);
  if (labelled) return { kind: 'number', n: Number(labelled[1]) };
  const month = /\b(20\d{2}|19\d{2})[-_.](0[1-9]|1[0-2])\b/.exec(name);
  if (month) return { kind: 'month', month: `${month[1]}-${month[2]}` };
  const trailing = /(?:^|[\s_-])(\d{1,4})(?:\D*)$/.exec(name);
  return trailing ? { kind: 'number', n: Number(trailing[1]) } : null;
}

/** Missing numbers between the smallest and the largest one (at most 500). */
export function numberGaps(nums: number[]): number[] {
  const sorted = [...new Set(nums)].toSorted((a, b) => a - b);
  if (sorted.length < 2) return [];
  const have = new Set(sorted);
  const missing: number[] = [];
  for (let n = sorted[0]!; n <= sorted.at(-1)! && missing.length < 500; n += 1) if (!have.has(n)) missing.push(n);
  return missing;
}

// ---------- diff ----------
const MAX_DIFF_LINES = 1500;
const normLine = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Line based diff (LCS on normalized lines, capped): lines only in A, only in B, and the number of common lines. */
export function diffLines(a: string, b: string): { onlyA: string[]; onlyB: string[]; common: number; capped: boolean } {
  const split = (t: string) =>
    t
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  const la = split(a);
  const lb = split(b);
  const capped = la.length > MAX_DIFF_LINES || lb.length > MAX_DIFF_LINES;
  const A = la.slice(0, MAX_DIFF_LINES);
  const B = lb.slice(0, MAX_DIFF_LINES);
  const na = A.map(normLine);
  const nb = B.map(normLine);
  const n = A.length;
  const m = B.length;
  const w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i -= 1)
    for (let j = m - 1; j >= 0; j -= 1) dp[i * w + j] = na[i] === nb[j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  let i = 0;
  let j = 0;
  let common = 0;
  while (i < n && j < m) {
    if (na[i] === nb[j]) {
      common += 1;
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) onlyA.push(A[i++]!);
    else onlyB.push(B[j++]!);
  }
  while (i < n) onlyA.push(A[i++]!);
  while (j < m) onlyB.push(B[j++]!);
  return { onlyA, onlyB, common, capped };
}

// ---------- dates & deadlines ----------
const MONTH_NAMES: Record<string, number> = {
  januar: 1,
  jan: 1,
  februar: 2,
  feb: 2,
  märz: 3,
  maerz: 3,
  april: 4,
  apr: 4,
  mai: 5,
  juni: 6,
  juli: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  oktober: 10,
  okt: 10,
  november: 11,
  nov: 11,
  dezember: 12,
  dez: 12,
};
const pad2 = (n: number) => String(n).padStart(2, '0');
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function isoOf(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** „31.12.2026“ → 2026-12-31 (deterministic). */
export const fmtDe = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

export type PeriodUnit = 'tag' | 'woche' | 'monat' | 'jahr';

/** Adds (or subtracts, `n < 0`) a period; months are clamped, and a month end stays a month end when counting back. */
export function addPeriod(iso: string, n: number, unit: PeriodUnit): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  if (unit === 'tag' || unit === 'woche') {
    const dt = new Date(Date.UTC(y, m - 1, d + n * (unit === 'woche' ? 7 : 1)));
    return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
  }
  const months = n * (unit === 'jahr' ? 12 : 1);
  const idx = y * 12 + (m - 1) + months;
  const ty = Math.floor(idx / 12);
  const tm = (idx % 12) + 1;
  const monthEnd = d === daysInMonth(y, m);
  const td = n < 0 && monthEnd ? daysInMonth(ty, tm) : Math.min(d, daysInMonth(ty, tm));
  return `${ty}-${pad2(tm)}-${pad2(td)}`;
}

interface DateHit {
  iso: string;
  index: number;
  end: number;
  monthOnly: boolean;
}

const DATE_RES: Array<{ re: RegExp; parse: (m: RegExpExecArray) => { iso: string | null; monthOnly: boolean } }> = [
  {
    re: /\b(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4}|\d{2})(?!\d)/g,
    parse: (m) => ({ iso: isoOf(m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]), Number(m[2]), Number(m[1])), monthOnly: false }),
  },
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, parse: (m) => ({ iso: isoOf(Number(m[1]), Number(m[2]), Number(m[3])), monthOnly: false }) },
  {
    re: /\b(\d{1,2})\.\s?(januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember)\s(\d{4})\b/gi,
    parse: (m) => ({ iso: isoOf(Number(m[3]), MONTH_NAMES[m[2]!.toLowerCase()] ?? 0, Number(m[1])), monthOnly: false }),
  },
  {
    // month/year („HU 08/2027“, „gültig bis 03/2030“) → last day of the month
    re: /(?<![\d./])(0?[1-9]|1[0-2])\/(\d{4}|\d{2})(?![\d/])/g,
    parse: (m) => {
      const y = m[2]!.length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
      const mo = Number(m[1]);
      return { iso: isoOf(y, mo, daysInMonth(y, mo)), monthOnly: true };
    },
  },
];

/** All dates in a text with their position. */
export function findDates(text: string): DateHit[] {
  const hits: DateHit[] = [];
  for (const { re, parse } of DATE_RES) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const { iso, monthOnly } = parse(m);
      const start = m.index;
      const end = start + m[0].length;
      if (iso && !hits.some((h) => start < h.end && h.index < end)) hits.push({ iso, index: start, end, monthOnly });
    }
  }
  return hits.toSorted((a, b) => a.index - b.index);
}

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

export interface Deadline {
  kind: DeadlineKind;
  /** YYYY-MM-DD; null when the reference date is missing */
  date: string | null;
  evidence: string;
  /** Computation path in plain language („Vertragsende 31.12.2026 − 3 Monate = 30.09.2026“). */
  rechenweg: string;
  past: boolean;
}

/** Keywords right before a date, the closest one wins. */
const DATE_KEYWORDS: Array<{ re: RegExp; kind: DeadlineKind | 'gueltig' | 'ende' }> = [
  { re: /\b(?:tüv|tuev|hu|hauptuntersuchung)\b/i, kind: 'tuev' },
  { re: /kündbar|kündigung|kuendigung/i, kind: 'kuendigung' },
  { re: /garantie|gewährleistung/i, kind: 'garantie' },
  { re: /widerspruch|widerruf|einspruch/i, kind: 'widerspruch' },
  { re: /fällig|faellig|zahlbar\s+bis|zahlungsziel|zu\s+zahlen\s+bis/i, kind: 'faelligkeit' },
  { re: /gültig\s+bis|gueltig\s+bis|gültigkeit|valid\s+until|expires?/i, kind: 'gueltig' },
  { re: /ablauf|läuft\s+ab|laeuft\s+ab|endet\s+am|endet\s+zum|vertragsende|laufzeit\s+bis|laufzeitende|befristet\s+bis/i, kind: 'ende' },
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
const toNumber = (s: string) => (/^\d+$/.test(s) ? Number(s) : (NUMBER_WORDS[s.toLowerCase()] ?? null));
const unitOf = (s: string): PeriodUnit => (/^tag/i.test(s) ? 'tag' : /^woche/i.test(s) ? 'woche' : /^jahr/i.test(s) ? 'jahr' : 'monat');
const UNIT_LABEL: Record<PeriodUnit, [string, string]> = {
  tag: ['Tag', 'Tage'],
  woche: ['Woche', 'Wochen'],
  monat: ['Monat', 'Monate'],
  jahr: ['Jahr', 'Jahre'],
};
const periodText = (n: number, u: PeriodUnit) => `${n} ${UNIT_LABEL[u][n === 1 ? 0 : 1]}`;
const COUNT = String.raw`(\d{1,3}|ein|eine|einem|einen|einer|zwei|drei|vier|fünf|sechs|acht|zehn|zwölf|vierzehn)`;
const UNIT = String.raw`(tag|tage|tagen|woche|wochen|monat|monate|monaten|jahr|jahre|jahren)`;

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

/**
 * Deadlines and expiry dates in a document text, each with the passage and the computation path. Relative periods
 * („Garantie 24 Monate“, „Widerspruch innerhalb von 4 Wochen“) count from `baseDate` (the document date).
 */
export function findDeadlines(text: string, baseDate: string | null, today: Date, opts: { baseLabel?: string } = {}): Deadline[] {
  const todayIso = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;
  const baseLabel = opts.baseLabel ?? 'Dokumentdatum';
  const lowerText = text.toLowerCase();
  const isId = /personalausweis|reisepass|\bausweis|führerschein|aufenthaltstitel|\bpass\b/.test(lowerText);
  const isInsurance = /versicherung|police|versicherungsschein/.test(lowerText);
  const out: Deadline[] = [];
  const add = (d: Omit<Deadline, 'past'>) => {
    if (out.some((o) => o.kind === d.kind && o.date === d.date)) return;
    out.push({ ...d, past: d.date !== null && d.date < todayIso });
  };
  const dates = findDates(text);
  let contractEnd: string | null = null;

  // 1) absolute dates near a keyword
  for (const h of dates) {
    const lineStart = text.lastIndexOf('\n', h.index) + 1;
    const before = text.slice(Math.max(lineStart, h.index - 70), h.index);
    let found: { kind: (typeof DATE_KEYWORDS)[number]['kind']; pos: number } | null = null;
    for (const k of DATE_KEYWORDS) {
      const re = new RegExp(k.re.source, 'gi');
      for (const m of before.matchAll(re)) if (!found || m.index > found.pos) found = { kind: k.kind, pos: m.index };
    }
    if (!found) continue;
    const kind: DeadlineKind =
      found.kind === 'gueltig'
        ? isId
          ? 'ausweis'
          : isInsurance
            ? 'versicherung'
            : 'ablauf'
        : found.kind === 'ende'
          ? isInsurance
            ? 'versicherung'
            : 'ablauf'
          : found.kind;
    if (found.kind === 'ende' && !contractEnd) contractEnd = h.iso;
    add({
      kind,
      date: h.iso,
      evidence: lineAt(text, h.index),
      rechenweg: `Datum steht im Text${h.monthOnly ? ' (Monat/Jahr → Monatsende)' : ''}: ${fmtDe(h.iso)}`,
    });
  }

  // 2) notice period before an end date („Kündigungsfrist 3 Monate zum Vertragsende 31.12.2026“)
  const noticeRe = new RegExp(
    String.raw`(?:kündigungsfrist|kuendigungsfrist|frist)(?::|\s(?:von|beträgt|betraegt))?\s{1,3}${COUNT}\s${UNIT}\s(?:zum|vor|bis\szum)\b([^\n]{0,80})`,
    'gi',
  );
  for (const m of text.matchAll(noticeRe)) {
    const n = toNumber(m[1]!);
    if (!n) continue;
    const unit = unitOf(m[2]!);
    const tail = m[3] ?? '';
    const endHit = findDates(tail)[0];
    const end = endHit?.iso ?? (/vertragsende|ablauf|laufzeit|ende/i.test(tail) ? contractEnd : null);
    const endLabel = /vertragsende/i.test(tail) ? 'Vertragsende' : /ablauf/i.test(tail) ? 'Ablauf' : 'Stichtag';
    if (!end) {
      add({
        kind: 'kuendigung',
        date: null,
        evidence: lineAt(text, m.index),
        rechenweg: `${periodText(n, unit)} vor dem ${endLabel} – das Datum dafür steht nicht im Text`,
      });
      continue;
    }
    const date = addPeriod(end, -n, unit);
    add({
      kind: 'kuendigung',
      date,
      evidence: lineAt(text, m.index),
      rechenweg: `${endLabel} ${fmtDe(end)} − ${periodText(n, unit)} = ${fmtDe(date)} (Kündigung muss spätestens dann zugehen)`,
    });
  }

  // 3) periods counted from the document date
  const relative: Array<{ re: RegExp; kind: DeadlineKind }> = [
    { re: new RegExp(String.raw`(?:widerspruch|widerruf|einspruch)[^\n.]{0,60}?innerhalb\s(?:von\s)?${COUNT}\s${UNIT}`, 'gi'), kind: 'widerspruch' },
    { re: new RegExp(String.raw`innerhalb\s(?:von\s)?${COUNT}\s${UNIT}[^\n.]{0,60}?(?:widerspruch|widerruf|einspruch)`, 'gi'), kind: 'widerspruch' },
    {
      re: new RegExp(String.raw`(?:garantie|gewährleistung|herstellergarantie)(?::|\s(?:von|beträgt|betraegt))?\s{1,3}${COUNT}\s${UNIT}`, 'gi'),
      kind: 'garantie',
    },
    { re: new RegExp(String.raw`${COUNT}\s${UNIT}\s(?:herstellergarantie|garantie|gewährleistung)`, 'gi'), kind: 'garantie' },
    { re: new RegExp(String.raw`zahlbar\sinnerhalb\s(?:von\s)?${COUNT}\s${UNIT}`, 'gi'), kind: 'faelligkeit' },
  ];
  for (const r of relative) {
    for (const m of text.matchAll(r.re)) {
      const n = toNumber(m[1]!);
      if (!n) continue;
      const unit = unitOf(m[2]!);
      if (!baseDate) {
        add({
          kind: r.kind,
          date: null,
          evidence: lineAt(text, m.index),
          rechenweg: `${periodText(n, unit)} ab ${baseLabel} – das ${baseLabel} ist unbekannt`,
        });
        continue;
      }
      const date = addPeriod(baseDate, n, unit);
      add({ kind: r.kind, date, evidence: lineAt(text, m.index), rechenweg: `${baseLabel} ${fmtDe(baseDate)} + ${periodText(n, unit)} = ${fmtDe(date)}` });
    }
  }
  return out.toSorted((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));
}

// ---------- secrets ----------
export const SECRET_LABEL: Record<string, string> = {
  secret: 'Passwort/Schlüssel',
  password: 'Zugangsdaten in einer Adresse',
  zugang: 'Benutzername/Zugangsdaten',
  pin: 'PIN/PUK/TAN',
  iban: 'IBAN',
  private_key: 'privater Schlüssel',
  aws_key: 'API-Schlüssel',
  api_key: 'API-Schlüssel',
  google_api_key: 'API-Schlüssel',
  github_token: 'Zugangstoken',
  slack_token: 'Zugangstoken',
  jwt: 'Zugangstoken',
  bearer: 'Zugangstoken',
};

function validIban(raw: string): boolean {
  const s = raw.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rest = 0;
  for (const ch of moved) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const digit of v) rest = (rest * 10 + Number(digit)) % 97;
  }
  return rest === 1;
}

/** Kinds and counts of secrets in a text – never the values. */
export function scanSecrets(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const bump = (kind: string, n = 1) => {
    if (n > 0) counts[SECRET_LABEL[kind] ?? kind] = (counts[SECRET_LABEL[kind] ?? kind] ?? 0) + n;
  };
  const redacted = redactSecrets(text).text;
  for (const m of redacted.matchAll(/\[REDACTED:(\w+)\]/g)) bump(m[1]!);
  bump('zugang', [...text.matchAll(/\b(?:benutzername|benutzerkennung|username|login|zugangsdaten|kundennummer\s+online)\s?[:=]\s?\S{2,}/gi)].length);
  bump('pin', [...text.matchAll(/\b(?:pin|puk|tan)(?:-?code|-?nummer)?\s?[:=]?\s?\d{4,8}\b/gi)].length);
  bump('iban', [...text.matchAll(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g)].filter((m) => validIban(m[0])).length);
  return counts;
}

// ---------- mail ----------
/** Subject without Re:/AW:/WG:/Fwd:/FW: prefixes, lower case. */
export function normalizeSubject(subject: string): string {
  let s = subject.trim();
  for (let i = 0; i < 10; i += 1) {
    const next = s.replace(/^(?:re|aw|wg|fwd?|fw|antw|sv|vs)(?:\[\d+\])?\s?:\s*/i, '').trim();
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, ' ').toLowerCase();
}

// ---------- payments ----------
export interface Payment {
  date: string;
  amount: number;
  text: string;
  line: string;
}

const STATEMENT_NUMBER_RE = /(?<![\d.])\d[\d.]{0,14},\d\d(?!\d)|(?<![\d.])\d{1,9}\.\d\d(?![\d.])/g;

/** Last amount of a statement line with its sign („-89,00“, „89,00 S“, „89,00-“, „+1.200,00 EUR H“). */
function statementAmount(rest: string): { value: number; index: number } | null {
  const last = [...rest.matchAll(STATEMENT_NUMBER_RE)].at(-1);
  if (!last) return null;
  const after = rest
    .slice(last.index + last[0].length)
    .replace('€', '')
    .replace(/eur/i, '')
    .trim();
  if (after.length > 1 || (after && !'-+SHsh'.includes(after))) return null;
  const value = parseNumber(last[0]);
  if (value === null) return null;
  let start = last.index;
  while (start > 0 && rest[start - 1] === ' ') start -= 1;
  const sign = rest[start - 1];
  const negative = sign === '-' || sign === '−' || after === '-' || after.toUpperCase() === 'S';
  return { value: negative ? -value : value, index: sign === '-' || sign === '−' || sign === '+' ? start - 1 : last.index };
}

/** Statement lines „15.07.2026 Stadtwerke Abschlag -89,00“: date at the start, signed amount at the end. */
export function parseStatement(text: string, fallbackYear: number): Payment[] {
  const out: Payment[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const d = /^(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})?\s/.exec(line);
    if (!d) continue;
    const year = d[3] ? (d[3].length === 2 ? 2000 + Number(d[3]) : Number(d[3])) : fallbackYear;
    const iso = isoOf(year, Number(d[2]), Number(d[1]));
    const rest = line.slice(d[0].length).replace(/^\d{1,2}\.\d{1,2}\.(?:\d{4}|\d{2})?\s/, '');
    const a = statementAmount(rest);
    if (!iso || !a) continue;
    out.push({ date: iso, amount: a.value, text: rest.slice(0, a.index).trim(), line });
  }
  return out;
}

/** Invoice number („Rechnungsnummer: RE-2026-0042“, „Rechnung Nr. 4711“, „Invoice #123“). */
export function invoiceNumber(text: string): string | null {
  const m = /(?:rechnungs-?\s?(?:nr|nummer)|rechnung\s(?:nr|nummer)|invoice\s?(?:no|number|#))\.?\s?[:#]?\s?([A-Z0-9][A-Z0-9/-]{2,24})/i.exec(text);
  if (!m) return null;
  let n = m[1]!;
  while (n.endsWith('-') || n.endsWith('/')) n = n.slice(0, -1);
  return n;
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export interface InvoiceInfo {
  id: string;
  date: string;
  amount: number | null;
  number: string | null;
}

/** Invoice ↔ payment: invoice number in the payment text, or the same amount (±0.01) 0–90 days after the invoice date. */
export function matchPayments(
  invoices: InvoiceInfo[],
  payments: Payment[],
): { matched: Array<{ invoice: InvoiceInfo; payment: Payment; by: 'number' | 'amount' }>; unpaid: InvoiceInfo[]; unmatched: Payment[] } {
  const used = new Set<number>();
  const matched: Array<{ invoice: InvoiceInfo; payment: Payment; by: 'number' | 'amount' }> = [];
  const unpaid: InvoiceInfo[] = [];
  for (const inv of invoices.toSorted((a, b) => a.date.localeCompare(b.date))) {
    const num = inv.number ? squash(inv.number) : '';
    let pick = num.length >= 3 ? payments.findIndex((p, i) => !used.has(i) && squash(p.text).includes(num)) : -1;
    let by: 'number' | 'amount' = 'number';
    if (pick < 0 && inv.amount !== null) {
      by = 'amount';
      let bestDays = Infinity;
      payments.forEach((p, i) => {
        const days = daysBetween(inv.date, p.date);
        if (!used.has(i) && Math.abs(Math.abs(p.amount) - inv.amount!) <= 0.01 && days >= 0 && days <= 90 && days < bestDays) {
          bestDays = days;
          pick = i;
        }
      });
    }
    if (pick < 0) unpaid.push(inv);
    else {
      used.add(pick);
      matched.push({ invoice: inv, payment: payments[pick]!, by });
    }
  }
  return { matched, unpaid, unmatched: payments.filter((_, i) => !used.has(i)) };
}

// ---------- tools ----------
const READABLE_EXT = new Set(['pdf', 'docx', 'pptx', 'xlsx', 'txt', 'md', 'markdown', 'eml']);
const skippedNote = (n: number) => (n ? `\n${n} nicht freigegebene Dokumente übersprungen.` : '');
const docsArg = list.describe('Dokument-IDs (D…) oder Ergebnismengen (S…)');

export function researchTools(deps: ToolDeps): AgentTool[] {
  const { docs, privacy } = deps;
  const text = (id: string) => docs.findRow(id)?.extractedText ?? '';
  /** Shareable documents of the refs; the rest is counted. */
  const shareable = (ctx: ToolContext, refs: readonly string[]) => {
    const { docs: found, unknown } = resolveDocs(deps, ctx, refs);
    const ok = found.filter((d) => privacy.mayShareDocument(d));
    return { docs: ok, skipped: found.length - ok.length, unknown };
  };
  const archivedDocs = () => allDocs(deps).filter((d) => ARCHIVED.includes(d.status));

  return [
    defineTool({
      name: 'sum_amounts',
      description:
        'Summiert Rechnungs- bzw. Belegbeträge mehrerer Dokumente deterministisch (Gesamt/Summe/Total-Zeile, sonst größter Betrag). Liefert Belegliste mit Fundstelle, Summe, Anzahl und Dokumente ohne Betrag. Rechne nie selbst nach – übernimm die Summe.',
      schema: z.object({ documents: docsArg }),
      risk: 'read',
      label: (a) => `Summiere Beträge aus ${a.documents.length} Angabe(n)`,
      run: async (a, ctx) => {
        const { docs: found, skipped, unknown } = shareable(ctx, a.documents);
        const rows: string[] = [];
        const without: string[] = [];
        const values: number[] = [];
        for (const d of found.toSorted((x, y) => docDay(x).localeCompare(docDay(y)))) {
          const total = invoiceTotal(text(d.id));
          if (!total) {
            without.push(ctx.refs.doc(d.id));
            continue;
          }
          values.push(total.amount);
          rows.push(
            `- ${docLine(d, ctx, privacy)}\n  Datum: ${docDay(d)} | Betrag: ${formatEuro(total.amount)} | Fundstelle: ${asData(ctx.refs.doc(d.id), total.line)}`,
          );
        }
        const sum = sumAmounts(values);
        const summary = `Summe ${formatEuro(sum)} aus ${values.length} Beleg${values.length === 1 ? '' : 'en'}`;
        return {
          content: [
            `Belegliste (${values.length}):`,
            ...rows,
            `SUMME: ${formatEuro(sum)} (${values.length} Belege, deterministisch berechnet)`,
            without.length ? `Ohne erkennbaren Betrag: ${without.join(', ')}` : null,
          ]
            .filter(Boolean)
            .join('\n')
            .concat(skippedNote(skipped), unknownNote(unknown)),
          summary,
        };
      },
    }),
    defineTool({
      name: 'find_gaps',
      description:
        'Findet Lücken in einer Serie (z. B. Kontoauszüge, Gehaltsabrechnungen): by="month" prüft die Monate zwischen erstem und letztem Dokument, by="number" die laufenden Nummern aus Titel/Dateiname („Nr. 12“, „Auszug 3“, „2025-07“).',
      schema: z.object({ documents: docsArg, by: z.enum(['month', 'number']).default('month') }),
      risk: 'read',
      label: (a) => `Suche Lücken (${a.by === 'month' ? 'Monate' : 'Nummern'})`,
      run: async (a, ctx) => {
        const { docs: found, skipped, unknown } = shareable(ctx, a.documents);
        if (!found.length) return { content: `Keine auswertbaren Dokumente.${skippedNote(skipped)}${unknownNote(unknown)}`, isError: true };
        const tail = skippedNote(skipped) + unknownNote(unknown);
        if (a.by === 'month') {
          const g = monthGaps(found.map((d) => d.documentDate ?? docDay(d)));
          const counts = new Map<string, number>();
          for (const d of found) counts.set((d.documentDate ?? docDay(d)).slice(0, 7), (counts.get((d.documentDate ?? docDay(d)).slice(0, 7)) ?? 0) + 1);
          const doubles = [...counts].filter(([, n]) => n > 1).map(([m, n]) => `${m} (${n}×)`);
          return {
            content: [
              `Zeitraum ${g.first} bis ${g.last}: ${g.present.length} Monate vorhanden, ${g.missing.length} fehlen.`,
              g.missing.length ? `Fehlende Monate: ${g.missing.join(', ')}` : 'Keine Lücke.',
              doubles.length ? `Mehrfach vorhanden: ${doubles.join(', ')}` : null,
            ]
              .filter(Boolean)
              .join('\n')
              .concat(tail),
            summary: g.missing.length ? `${g.missing.length} Monat(e) fehlen` : 'keine Lücke',
          };
        }
        const seq = found.map((d) => ({ d, s: sequenceNumber(d.title) ?? sequenceNumber(d.originalName) }));
        const months = seq.flatMap((x) => (x.s?.kind === 'month' ? [x.s.month] : []));
        const nums = seq.flatMap((x) => (x.s?.kind === 'number' ? [x.s.n] : []));
        const without = seq.filter((x) => !x.s).map((x) => ctx.refs.doc(x.d.id));
        if (months.length > nums.length) {
          const g = monthGaps(months.map((m) => `${m}-01`));
          return {
            content: `Nummerierung nach Monat im Namen, ${g.first} bis ${g.last}: ${g.missing.length ? `fehlend ${g.missing.join(', ')}` : 'keine Lücke'}.${without.length ? `\nOhne erkennbare Nummer: ${without.join(', ')}` : ''}${tail}`,
            summary: g.missing.length ? `${g.missing.length} fehlen` : 'keine Lücke',
          };
        }
        if (!nums.length) return { content: `In Titel und Dateinamen ist keine laufende Nummer erkennbar – by="month" versuchen.${tail}` };
        const missing = numberGaps(nums);
        const sorted = [...new Set(nums)].toSorted((x, y) => x - y);
        return {
          content: `Nummern ${sorted[0]} bis ${sorted.at(-1)} (${sorted.length} vorhanden): ${missing.length ? `fehlend ${missing.join(', ')}` : 'keine Lücke'}.${without.length ? `\nOhne erkennbare Nummer: ${without.join(', ')}` : ''}${tail}`,
          summary: missing.length ? `${missing.length} Nummer(n) fehlen` : 'keine Lücke',
        };
      },
    }),
    defineTool({
      name: 'compare_documents',
      description: 'Vergleicht zwei Dokumente zeilenweise: was steht nur in A, was nur in B (z. B. zwei Vertragsfassungen). Beide müssen freigegeben sein.',
      schema: z.object({ a: z.string().min(1), b: z.string().min(1) }),
      risk: 'read',
      label: () => 'Vergleiche zwei Dokumente',
      run: async (a, ctx) => {
        const { docs: found, unknown } = resolveDocs(deps, ctx, [a.a, a.b]);
        const da = found.find((d) => d.id === ctx.refs.resolve(a.a));
        const db = found.find((d) => d.id === ctx.refs.resolve(a.b));
        if (!da || !db) return { content: `Zwei bekannte Dokument-IDs nötig.${unknownNote(unknown)}`, isError: true };
        if (!privacy.mayShareDocument(da) || !privacy.mayShareDocument(db))
          return { content: 'Mindestens eines der Dokumente ist nicht zur Übertragung freigegeben – der Vergleich ist nicht möglich.', isError: true };
        const r = diffLines(text(da.id), text(db.id));
        const ra = ctx.refs.doc(da.id);
        const rb = ctx.refs.doc(db.id);
        const show = (lines: string[]) => lines.slice(0, 80).join('\n') + (lines.length > 80 ? `\n… und ${lines.length - 80} weitere Zeilen` : '');
        return {
          content: [
            `A = ${docLine(da, ctx, privacy)}`,
            `B = ${docLine(db, ctx, privacy)}`,
            `${r.common} gemeinsame Zeilen, ${r.onlyA.length} nur in A, ${r.onlyB.length} nur in B${r.capped ? ` (nur die ersten ${MAX_DIFF_LINES} Zeilen verglichen)` : ''}.`,
            r.onlyA.length ? `Nur in A:\n${asData(`${ra}-nur-A`, show(r.onlyA))}` : 'Nur in A: –',
            r.onlyB.length ? `Nur in B:\n${asData(`${rb}-nur-B`, show(r.onlyB))}` : 'Nur in B: –',
          ].join('\n'),
          summary: `${r.onlyA.length} nur in A, ${r.onlyB.length} nur in B`,
        };
      },
    }),
    defineTool({
      name: 'find_deadlines',
      description:
        'Erkennt Fristen und Ablaufdaten (Kündigung, Garantie, Ausweis, Versicherung, TÜV/HU, Widerspruch, Ablauf, Fälligkeit) mit Fundstelle und Rechenweg. Nennt, ob für das Dokument schon eine Erinnerung besteht („Erinnerung vorhanden“ – dann keine zweite anlegen).',
      schema: z.object({ documents: docsArg }),
      risk: 'read',
      label: () => 'Suche Fristen und Ablaufdaten',
      run: async (a, ctx) => {
        const { docs: found, unknown } = resolveDocs(deps, ctx, a.documents);
        const pending = deps.reminders.list('pending');
        const today = new Date();
        const lines: string[] = [];
        let count = 0;
        for (const d of found) {
          const base = d.documentDate ? d.documentDate.slice(0, 10) : docDay(d);
          const hits = findDeadlines(text(d.id), base, today, { baseLabel: d.documentDate ? 'Dokumentdatum' : 'Archivdatum' });
          if (!hits.length) continue;
          const reminders = pending.filter((r) => r.targetId === d.id);
          const reminderNote = reminders.length
            ? ` | Erinnerung vorhanden (${reminders.map((r) => r.remindAt.slice(0, 10)).join(', ')})`
            : ' | keine Erinnerung';
          count += hits.length;
          if (!privacy.mayShareDocument(d)) {
            for (const h of hits)
              lines.push(`- ${ctx.refs.doc(d.id)} [nicht freigegeben]: Frist am ${h.date ?? 'unbekannt'} (Art: ${DEADLINE_LABEL[h.kind]})${reminderNote}`);
            continue;
          }
          lines.push(`- ${docLine(d, ctx, privacy)}${reminderNote}`);
          for (const h of hits)
            lines.push(
              `  • ${DEADLINE_LABEL[h.kind]}: ${h.date ?? 'Datum offen'}${h.past ? ' (bereits vorbei)' : ''} – Rechenweg: ${h.rechenweg}\n    Fundstelle: ${asData(ctx.refs.doc(d.id), h.evidence)}`,
            );
        }
        if (!lines.length) return { content: `Keine Fristen erkannt.${unknownNote(unknown)}`, summary: 'keine Fristen' };
        return { content: lines.join('\n') + unknownNote(unknown), summary: `${count} Frist(en) erkannt` };
      },
    }),
    defineTool({
      name: 'find_secrets',
      description:
        'Prüft Dokumente lokal auf Passwörter, Zugangsdaten, PINs, IBANs und API-Schlüssel. Nennt je Dokument nur Arten und Anzahl, nie die Werte. Ohne Angabe: alle archivierten Dokumente.',
      schema: z.object({ documents: list.nullish().describe('D…/S…; leer = alle archivierten') }),
      risk: 'read',
      label: () => 'Suche nach Passwörtern und Zugangsdaten',
      run: async (a, ctx) => {
        const { docs: found, unknown } = a.documents?.length ? resolveDocs(deps, ctx, a.documents) : { docs: archivedDocs(), unknown: [] as string[] };
        const lines: string[] = [];
        for (const d of found) {
          const kinds = scanSecrets(text(d.id));
          const entries = Object.entries(kinds);
          if (!entries.length) continue;
          const what = entries.map(([k, n]) => `${n}× ${k}`).join(', ');
          lines.push(
            privacy.mayShareDocument(d) ? `- ${docLine(d, ctx, privacy)}\n  enthält: ${what}` : `- ${ctx.refs.doc(d.id)} [nicht freigegeben]: enthält ${what}`,
          );
        }
        if (!lines.length) return { content: `In ${found.length} geprüften Dokumenten nichts gefunden.${unknownNote(unknown)}`, summary: 'nichts gefunden' };
        return {
          content: `${lines.length} von ${found.length} Dokumenten enthalten mögliche Geheimnisse (Werte werden nie angezeigt):\n${lines.join('\n')}\nVorschlag: diese Dokumente mit exclude_from_llm von der Übertragung an das LLM ausschließen.${unknownNote(unknown)}`,
          summary: `${lines.length} Dokument(e) mit möglichen Geheimnissen`,
        };
      },
    }),
    defineTool({
      name: 'problem_files',
      description:
        'Problemdateien: fehlgeschlagene oder in Quarantäne gelegte Dokumente, verschlüsselte PDFs, Endung passt nicht zum Inhalt, lesbare Dateien ohne Text – mit Erklärung.',
      schema: z.object({}),
      risk: 'read',
      label: () => 'Suche Problemdateien',
      run: async (_a, ctx) => {
        const lines: string[] = [];
        let skipped = 0;
        for (const d of allDocs(deps)) {
          const reasons = problemReasons(d);
          if (!reasons.length) continue;
          if (!privacy.mayShareDocument(d)) {
            skipped += 1;
            continue;
          }
          lines.push(`- ${docLine(d, ctx, privacy)}\n  ${reasons.join('\n  ')}`);
        }
        if (!lines.length) return { content: `Keine Problemdateien gefunden.${skippedNote(skipped)}`, summary: 'keine Probleme' };
        return {
          content: lines.slice(0, 100).join('\n') + (lines.length > 100 ? `\n… und ${lines.length - 100} weitere` : '') + skippedNote(skipped),
          summary: `${lines.length} Problemdatei(en)`,
        };
      },
    }),
    defineTool({
      name: 'storage_report',
      description: 'Speicherbericht: größte Dateien, exakte Duplikate (verschwendeter Platz), alte Dokumente ohne Verknüpfungen. Nur Hinweise, ändert nichts.',
      schema: z.object({}),
      risk: 'read',
      label: () => 'Erstelle einen Speicherbericht',
      run: async (_a, ctx) => {
        const all = archivedDocs();
        const ok = all.filter((d) => privacy.mayShareDocument(d));
        const skipped = all.length - ok.length;
        const total = all.reduce((s, d) => s + d.size, 0);
        const largest = ok.toSorted((x, y) => y.size - x.size).slice(0, 15);
        const bySha = new Map<string, DocumentRecord[]>();
        for (const d of ok) bySha.set(d.sha256, [...(bySha.get(d.sha256) ?? []), d]);
        const dupGroups = [...bySha.values()].filter((g) => g.length > 1).toSorted((x, y) => y[0]!.size * (y.length - 1) - x[0]!.size * (x.length - 1));
        const wasted = dupGroups.reduce((s, g) => s + g[0]!.size * (g.length - 1), 0);
        const lonely: DocumentRecord[] = [];
        for (const d of ok.toSorted((x, y) => (x.archivedAt ?? x.createdAt).localeCompare(y.archivedAt ?? y.createdAt))) {
          if (lonely.length >= 10) break;
          const rel = deps.graph.relationsOf(d.id).filter((r) => r.status !== 'rejected' && r.status !== 'outdated');
          const meaningful = rel.filter((r) => {
            const other = deps.graph.getEntity(r.sourceEntityId === d.id ? r.targetEntityId : r.sourceEntityId);
            return other && other.type !== 'category' && other.type !== 'tag';
          });
          if (!meaningful.length && !d.topicId && !d.projectId) lonely.push(d);
        }
        return {
          content: [
            `Archiv: ${all.length} Dokumente, ${mb(total)} gesamt.`,
            `Größte Dateien:`,
            ...largest.map((d) => `- ${mb(d.size)}: ${docLine(d, ctx, privacy)}`),
            dupGroups.length ? `Exakte Duplikate (gleicher Inhalt): ${dupGroups.length} Gruppen, ${mb(wasted)} verschwendet:` : 'Keine exakten Duplikate.',
            ...dupGroups
              .slice(0, 15)
              .map((g) => `- ${g.length}× ${mb(g[0]!.size)}: ${g.map((d) => ctx.refs.doc(d.id)).join(', ')} – „${truncate(g[0]!.title, 60)}“`),
            lonely.length ? 'Lange nicht genutzt (älteste archivierte Dokumente ohne Thema, Projekt oder Verknüpfung):' : null,
            ...lonely.map((d) => `- ${docLine(d, ctx, privacy)}`),
            'Nur Hinweise – gelöscht oder verschoben wird nichts ohne ausdrücklichen Auftrag (find_duplicates / mark_duplicates).',
          ]
            .filter(Boolean)
            .join('\n')
            .concat(skippedNote(skipped)),
          summary: `${mb(total)}, ${dupGroups.length} Duplikatgruppen`,
        };
      },
    }),
    defineTool({
      name: 'email_threads',
      description: 'Gruppiert E-Mails (.eml) nach Betreff (ohne Re:/AW:/WG:/Fwd:) zu Verläufen mit mindestens zwei Nachrichten, chronologisch.',
      schema: z.object({ documents: list.nullish().describe('D…/S…; leer = alle .eml-Dateien') }),
      risk: 'read',
      label: () => 'Fasse E-Mails zu Verläufen zusammen',
      run: async (a, ctx) => {
        const source = a.documents?.length
          ? resolveDocs(deps, ctx, a.documents)
          : { docs: allDocs(deps).filter((d) => lower(d.ext) === 'eml' && d.status !== 'ignored'), unknown: [] as string[] };
        const mails = source.docs.filter((d) => lower(d.ext) === 'eml');
        const ok = mails.filter((d) => privacy.mayShareDocument(d));
        const groups = new Map<string, DocumentRecord[]>();
        for (const d of ok) {
          const subject = /^Betreff:\s?(.*?)\s(?:Von|An|Datum):/.exec(d.textPreview)?.[1] ?? d.title;
          const key = normalizeSubject(subject);
          if (key) groups.set(key, [...(groups.get(key) ?? []), d]);
        }
        const threads = [...groups].filter(([, g]) => g.length >= 2).toSorted((x, y) => y[1].length - x[1].length);
        if (!threads.length)
          return {
            content: `Keine Verläufe mit mehreren Nachrichten gefunden (${ok.length} E-Mails geprüft).${skippedNote(mails.length - ok.length)}${unknownNote(source.unknown)}`,
            summary: 'keine Verläufe',
          };
        const lines = threads.slice(0, 40).map(([subject, g]) => {
          const sorted = g.toSorted((x, y) => (x.documentDate ?? docDay(x)).localeCompare(y.documentDate ?? docDay(y)));
          return `Verlauf „${truncate(subject, 80)}“ (${g.length} Nachrichten, Ergebnismenge ${ctx.refs.set(sorted.map((d) => d.id))}):\n${sorted.map((d) => `  - ${docLine(d, ctx, privacy)}`).join('\n')}`;
        });
        return { content: lines.join('\n') + skippedNote(mails.length - ok.length) + unknownNote(source.unknown), summary: `${threads.length} Verläufe` };
      },
    }),
    defineTool({
      name: 'match_payments',
      description:
        'Gleicht Rechnungen mit Kontoauszügen ab: Zahlung mit gleichem Betrag (±0,01) 0–90 Tage nach Rechnungsdatum oder mit der Rechnungsnummer im Verwendungszweck. Liefert bezahlte und offene Rechnungen sowie Zahlungen ohne Rechnung.',
      schema: z.object({ statements: list.describe('Kontoauszüge (D…/S…)'), invoices: list.describe('Rechnungen (D…/S…)') }),
      risk: 'read',
      label: () => 'Gleiche Rechnungen mit Zahlungen ab',
      run: async (a, ctx) => {
        const st = shareable(ctx, a.statements);
        const inv = shareable(ctx, a.invoices);
        const payments = st.docs.flatMap((d) => parseStatement(text(d.id), Number((d.documentDate ?? docDay(d)).slice(0, 4))));
        const infos: InvoiceInfo[] = inv.docs.map((d) => {
          const t = text(d.id);
          return { id: d.id, date: (d.documentDate ?? docDay(d)).slice(0, 10), amount: invoiceTotal(t)?.amount ?? null, number: invoiceNumber(t) };
        });
        const r = matchPayments(infos, payments);
        const byId = new Map(inv.docs.map((d) => [d.id, d]));
        const label = (i: InvoiceInfo) =>
          `${docLine(byId.get(i.id)!, ctx, privacy)} | ${i.amount === null ? 'Betrag unbekannt' : formatEuro(i.amount)}${i.number ? ` | Nr. ${i.number}` : ''}`;
        const payLine = (p: Payment) => asData('Kontoauszug', `${p.date} ${formatEuro(p.amount)} ${truncate(p.text, 120)}`);
        return {
          content: [
            `${payments.length} Buchungen aus ${st.docs.length} Auszügen, ${infos.length} Rechnungen.`,
            `Bezahlt (${r.matched.length}):`,
            ...r.matched.map(
              (m) => `- ${label(m.invoice)}\n  Zahlung (${m.by === 'number' ? 'Rechnungsnummer im Text' : 'gleicher Betrag'}): ${payLine(m.payment)}`,
            ),
            `Offen (${r.unpaid.length}):`,
            ...r.unpaid.map((i) => `- ${label(i)}`),
            `Zahlungen ohne Rechnung (${r.unmatched.length}${r.unmatched.length > 30 ? ', die ersten 30' : ''}):`,
            ...r.unmatched.slice(0, 30).map((p) => `- ${payLine(p)}`),
          ]
            .join('\n')
            .concat(skippedNote(st.skipped + inv.skipped), unknownNote([...st.unknown, ...inv.unknown])),
          summary: `${r.matched.length} bezahlt, ${r.unpaid.length} offen`,
        };
      },
    }),
    defineTool({
      name: 'similar_filings',
      description:
        'Beispiele, wie der Benutzer ähnliche Dokumente (gleicher Typ, gleiche Personen, ähnlicher Titel) abgelegt hat – mit Ordner. Nur Beispiele als Orientierung, keine Regel.',
      schema: z.object({ document: z.string().min(1) }),
      risk: 'read',
      label: () => 'Suche Beispiele ähnlich abgelegter Dokumente',
      run: async (a, ctx) => {
        const { docs: found, unknown } = resolveDocs(deps, ctx, [a.document]);
        const target = found[0];
        if (!target) return { content: `Unbekannte Dokument-ID „${a.document}“.${unknownNote(unknown)}`, isError: true };
        const persons = new Set(target.persons.map((p) => p.toLowerCase()));
        const scored = archivedDocs()
          .filter((d) => d.id !== target.id && d.status === 'archived' && d.archiveRelPath && privacy.mayShareDocument(d))
          .map((d) => {
            const sameType = Boolean(target.docType && d.docType && lower(target.docType) === lower(d.docType));
            const shared = d.persons.filter((p) => persons.has(p.toLowerCase())).length;
            const title = nameSimilarity(target.title, d.title);
            return { d, score: (sameType ? 0.4 : 0) + (shared ? 0.25 : 0) + title * 0.35, sameType, shared, title };
          })
          .filter((x) => x.score >= 0.25)
          .toSorted((x, y) => y.score - x.score)
          .slice(0, 5);
        if (!scored.length) return { content: 'Keine ähnlich abgelegten Dokumente gefunden.', summary: 'keine Beispiele' };
        return {
          content: [
            `BEISPIELE (keine Regel) – so wurden ähnliche Dokumente zu ${docLine(target, ctx, privacy)} abgelegt:`,
            ...scored.map(
              (x) =>
                `- Ordner ${folderLabel(folderOf(x.d))}: ${docLine(x.d, ctx, privacy)} (ähnlich wegen ${[x.sameType ? 'gleichem Typ' : null, x.shared ? 'gleichen Personen' : null, x.title >= 0.5 ? 'ähnlichem Titel' : null].filter(Boolean).join(', ') || 'Titel'})`,
            ),
          ].join('\n'),
          summary: `${scored.length} Beispiel(e)`,
        };
      },
    }),
  ];
}

const mb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** Plain-language explanation of what is wrong with a document (empty: nothing). */
export function problemReasons(d: Pick<DocumentRecord, 'status' | 'processingError' | 'ext' | 'mime' | 'textLength' | 'processingStatus'>): string[] {
  const out: string[] = [];
  const err = d.processingError ?? '';
  if (/passwor|password|verschlüssel|encrypt/i.test(err))
    out.push('Die Datei ist vermutlich verschlüsselt bzw. passwortgeschützt – ohne Passwort lässt sich kein Text lesen.');
  if (d.status === 'quarantined') out.push('In Quarantäne: Der Inhalt passt nicht zur Dateiendung. Die Datei wurde weder gelesen noch analysiert.');
  else if (d.status === 'failed') out.push(`Verarbeitung fehlgeschlagen${err ? `: ${truncate(err, 160)}` : ''} – „Erneut verarbeiten“ versuchen.`);
  else if (err && !out.length) out.push(`Hinweis bei der Verarbeitung: ${truncate(err, 160)}`);
  const expected = MIME_BY_EXT[d.ext.toLowerCase()];
  if (expected && d.mime && d.mime !== expected && d.mime !== 'application/octet-stream') out.push(`Endung .${d.ext} passt nicht zum Dateityp (${d.mime}).`);
  if (ARCHIVED.includes(d.status) && READABLE_EXT.has(d.ext.toLowerCase()) && d.textLength === 0)
    out.push('Kein Text erkannt, obwohl der Dateityp lesbar ist – vermutlich ein Scan ohne Texterkennung oder eine leere bzw. beschädigte Datei.');
  return out;
}
