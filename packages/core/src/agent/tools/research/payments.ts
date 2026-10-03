import { parseNumber } from './amounts';
import { findDates, fullYear, isoOf } from './dates';

export interface Payment {
  date: string;
  amount: number;
  text: string;
  line: string;
}

const STATEMENT_NUMBER_RE = /(?<![\d.])\d[\d.]{0,14},\d\d(?!\d)|(?<![\d.])\d{1,9}\.\d\d(?![\d.])/g;

const isMinus = (sign: string | undefined) => sign === '-' || sign === '−';

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
  const negative = isMinus(sign) || after === '-' || after.toUpperCase() === 'S';
  return { value: negative ? -value : value, index: isMinus(sign) || sign === '+' ? start - 1 : last.index };
}

const unquote = (field: string) =>
  field
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .trim();
const CURRENCY_FIELD_RE = /^(?:eur|€)?$/i;

/** CSV export line „15.07.2026;Stadtwerke;-89,00“ (separator ; or tab; date first, amount last, optional currency column). */
function parseCsvLine(line: string): Payment | null {
  const separator = line.includes(';') ? ';' : line.includes('\t') ? '\t' : null;
  if (!separator) return null;
  const fields = line.split(separator).map(unquote);
  while (fields.length > 3 && CURRENCY_FIELD_RE.test(fields.at(-1)!)) fields.pop();
  const date = fields.length >= 3 ? findDates(fields[0]!)[0] : undefined;
  const amount = parseNumber(
    fields
      .at(-1)!
      .replace(/(?:€|eur)$/i, '')
      .trim(),
  );
  if (!date || amount === null) return null;
  return { date: date.iso, amount, text: fields.slice(1, -1).join(' ').trim(), line };
}

/** Free-text line „15.07.2026 Stadtwerke Abschlag -89,00“ or „2026-07-15 …“: date at the start, signed amount at the end. */
function parseTextLine(line: string, fallbackYear: number): Payment | null {
  const german = /^(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})?\s/.exec(line);
  const isoDate = german ? null : /^(\d{4})-(\d{2})-(\d{2})\s/.exec(line);
  const date = german ?? isoDate;
  if (!date) return null;
  const day = german
    ? { year: german[3] ? fullYear(german[3]) : fallbackYear, month: Number(german[2]), day: Number(german[1]) }
    : { year: Number(isoDate![1]), month: Number(isoDate![2]), day: Number(isoDate![3]) };
  const iso = isoOf(day);
  const rest = line.slice(date[0].length).replace(/^\d{1,2}\.\d{1,2}\.(?:\d{4}|\d{2})?\s/, '');
  const amount = statementAmount(rest);
  return iso && amount ? { date: iso, amount: amount.value, text: rest.slice(0, amount.index).trim(), line } : null;
}

/** Statement lines in free text or CSV form; lines in neither form are ignored. */
export function parseStatement(text: string, fallbackYear: number): Payment[] {
  const payments: Payment[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const payment = parseCsvLine(line) ?? parseTextLine(line, fallbackYear);
    if (payment) payments.push(payment);
  }
  return payments;
}

/** Invoice number („Rechnungsnummer: RE-2026-0042“, „Rechnung Nr. 4711“, „Invoice #123“). */
export function invoiceNumber(text: string): string | null {
  const m = /(?:rechnungs-?\s?(?:nr|nummer)|rechnung\s(?:nr|nummer)|invoice\s?(?:no|number|#))\.?\s?[:#]?\s?([A-Z0-9][A-Z0-9/-]{2,24})/i.exec(text);
  if (!m) return null;
  let number = m[1]!;
  while (number.endsWith('-') || number.endsWith('/')) number = number.slice(0, -1);
  return number;
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

export interface InvoiceInfo {
  id: string;
  date: string;
  amount: number | null;
  number: string | null;
}

type MatchedBy = 'number' | 'amount';

interface PaymentPool {
  payments: Payment[];
  used: Set<number>;
}

/** Index of the first unused payment whose text names the invoice number, or -1. */
function paymentByNumber(invoice: InvoiceInfo, { payments, used }: PaymentPool): number {
  const number = invoice.number ? squash(invoice.number) : '';
  return number.length >= 3 ? payments.findIndex((p, i) => !used.has(i) && squash(p.text).includes(number)) : -1;
}

/** Index of the earliest unused payment of the same amount (±0.01) 0–90 days after the invoice, or -1. */
function paymentByAmount(invoice: InvoiceInfo, { payments, used }: PaymentPool): number {
  const amount = invoice.amount;
  if (amount === null) return -1;
  let pick = -1;
  let bestDays = Infinity;
  payments.forEach((p, i) => {
    const days = daysBetween(invoice.date, p.date);
    if (!used.has(i) && Math.abs(Math.abs(p.amount) - amount) <= 0.01 && days >= 0 && days <= 90 && days < bestDays) {
      bestDays = days;
      pick = i;
    }
  });
  return pick;
}

/** Invoice ↔ payment: invoice number in the payment text, or the same amount (±0.01) 0–90 days after the invoice date. */
export function matchPayments(
  invoices: InvoiceInfo[],
  payments: Payment[],
): { matched: Array<{ invoice: InvoiceInfo; payment: Payment; by: MatchedBy }>; unpaid: InvoiceInfo[]; unmatched: Payment[] } {
  const used = new Set<number>();
  const pool = { payments, used };
  const matched: Array<{ invoice: InvoiceInfo; payment: Payment; by: MatchedBy }> = [];
  const unpaid: InvoiceInfo[] = [];
  for (const invoice of invoices.toSorted((a, b) => a.date.localeCompare(b.date))) {
    const byNumber = paymentByNumber(invoice, pool);
    const pick = byNumber >= 0 ? byNumber : paymentByAmount(invoice, pool);
    if (pick < 0) {
      unpaid.push(invoice);
      continue;
    }
    used.add(pick);
    matched.push({ invoice, payment: payments[pick]!, by: byNumber >= 0 ? 'number' : 'amount' });
  }
  return { matched, unpaid, unmatched: payments.filter((_, i) => !used.has(i)) };
}
