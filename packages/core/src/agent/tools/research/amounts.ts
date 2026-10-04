/** A number as written in a document: „1.234,56“, „1,234.56“, „99,00“, „12.50“, „1.234“ (thousands). */
export function parseNumber(raw: string): number | null {
  let digits = raw.replace(/[\s'\u00a0\u202f]/g, '');
  const negative = digits.startsWith('-') || digits.startsWith('−');
  digits = digits.replace(/^[-+−]/, '');
  if (!/^\d[\d.,]*$/.test(digits)) return null;
  const { integer, fraction } = splitDecimal(digits);
  const integerDigits = integer.replace(/[.,]/g, '');
  if (!/^\d+$/.test(integerDigits) || !/^\d{0,2}$/.test(fraction)) return null;
  const value = Number(`${integerDigits}.${fraction || '0'}`);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

function splitDecimal(digits: string): { integer: string; fraction: string } {
  const lastDot = digits.lastIndexOf('.');
  const lastComma = digits.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = Math.max(lastDot, lastComma);
    return { integer: digits.slice(0, decimal), fraction: digits.slice(decimal + 1) };
  }
  if (lastComma < 0 && lastDot < 0) return { integer: digits, fraction: '' };
  const separator = lastComma >= 0 ? ',' : '.';
  const index = digits.lastIndexOf(separator);
  const tail = digits.slice(index + 1);
  // exactly three digits after the last separator: thousands („1.234“, „1.234.567“); otherwise decimals
  if (tail.length === 3) return { integer: digits.split(separator).join(''), fraction: '' };
  return { integer: digits.slice(0, index), fraction: tail };
}

/** Shorthand for tests and callers: one money string → value („1.234,56 €“ → 1234.56). */
export function parseAmount(text: string): number | null {
  return findAmounts(text)[0]?.value ?? null;
}

const NUMBER = String.raw`[-−]?\d{1,3}(?:[.,'\u00a0 ]\d{3})+(?:[.,]\d{1,2})?|[-−]?\d+(?:[.,]\d{1,2})?`;
const MONEY_RE = new RegExp(String.raw`(?:€|\bEUR\b)\s?(${NUMBER})|(${NUMBER})\s?(?:€|EUR\b)`, 'gi');
const PLAIN_DECIMAL_RE = /(?<![\d.,])[-−]?\d{1,3}(?:\.\d{3})*,\d{2}(?![\d,])|(?<![\d.,])[-−]?\d+\.\d{2}(?![\d.])/g;

/** Money amounts with currency (€/EUR) in a text, in order. */
export function findAmounts(text: string): Array<{ value: number; raw: string }> {
  const amounts: Array<{ value: number; raw: string }> = [];
  for (const match of text.matchAll(MONEY_RE)) {
    const value = parseNumber(match[1] ?? match[2] ?? '');
    if (value !== null) amounts.push({ value, raw: match[0].trim() });
  }
  return amounts;
}

const STRONG_TOTAL_RE = /gesamt|rechnungsbetrag|endbetrag|zu\s+zahlen|\btotal\b|bruttobetrag|zahlbetrag|amount\s+due/i;
const WEAK_TOTAL_RE = /summe|betrag/i;
const NOT_TOTAL_RE = /zwischensumme|netto|subtotal|mwst|ust\b|umsatzsteuer|steuer|rabatt|skonto|bereits\s+bezahlt/i;

interface TotalCandidate {
  amount: number;
  line: string;
  score: number;
}

function totalScore(line: string): number {
  const keyword = STRONG_TOTAL_RE.test(line) ? 2 : WEAK_TOTAL_RE.test(line) ? 1 : 0;
  const penalty = NOT_TOTAL_RE.test(line) && !/gesamt|brutto/i.test(line) ? 2 : 0;
  return keyword - penalty;
}

/** Largest positive amount of a line; total lines also count plain decimals without a currency. */
function lineTotal(line: string): TotalCandidate | null {
  let amounts = findAmounts(line).map((a) => a.value);
  const totalLine = STRONG_TOTAL_RE.test(line) || WEAK_TOTAL_RE.test(line);
  if (!amounts.length && totalLine) amounts = [...line.matchAll(PLAIN_DECIMAL_RE)].map((m) => parseNumber(m[0]) ?? 0);
  const positive = amounts.filter((a) => a > 0);
  if (!positive.length) return null;
  return { amount: Math.max(...positive), line, score: totalScore(line) };
}

const betterTotal = (candidate: TotalCandidate, best: TotalCandidate | null) =>
  !best || candidate.score > best.score || (candidate.score === best.score && candidate.amount >= best.amount);

const lineCandidates = (text: string) => text.split(/\r?\n/).flatMap((raw) => lineTotal(raw.trim()) ?? []);
const asTotal = (candidate: TotalCandidate | null) => (candidate ? { amount: candidate.amount, line: candidate.line } : null);

/** Total from a line labelled Gesamt/Summe/Total …; subtotal, net and tax lines lose against it. */
export function labelledTotal(text: string): { amount: number; line: string } | null {
  let best: TotalCandidate | null = null;
  for (const candidate of lineCandidates(text)) if (candidate.score > 0 && betterTotal(candidate, best)) best = candidate;
  return asTotal(best);
}

/** Invoice total of a text: the labelled total, otherwise the largest amount. */
export function invoiceTotal(text: string): { amount: number; line: string } | null {
  let largest: TotalCandidate | null = null;
  for (const candidate of lineCandidates(text)) if (!largest || candidate.amount > largest.amount) largest = candidate;
  return labelledTotal(text) ?? asTotal(largest);
}

/** 1234.56 → „1.234,56 €“ (deterministic, without locale data). */
export function formatEuro(value: number): string {
  const cents = Math.round(Math.abs(value) * 100);
  const digits = String(Math.floor(cents / 100));
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= 3) groups.unshift(digits.slice(Math.max(0, end - 3), end));
  return `${value < 0 ? '-' : ''}${groups.join('.')},${String(cents % 100).padStart(2, '0')} €`;
}

/** Exact sum via cents. */
export const sumAmounts = (values: number[]) => values.reduce((sum, value) => sum + Math.round(value * 100), 0) / 100;
