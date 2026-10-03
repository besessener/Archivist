import { nameSimilarity } from '../../../util/text';
import { invoiceTotal } from './amounts';
import { findDates } from './dates';

export interface ReceiptFacts {
  amount: number | null;
  amountLine: string | null;
  /** YYYY-MM-DD */
  date: string | null;
  merchant: string | null;
}

const NOT_A_MERCHANT_RE = /^[\d\s.,:;€*#/+-]*$|\d{1,2}\.\d{1,2}\.\d{2,4}|\d[.,]\d{2}/;

/** First text line that is no date or amount – on a receipt that is the shop. */
function merchantOf(text: string): string | null {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /\p{L}{3}/u.test(l) && !NOT_A_MERCHANT_RE.test(l));
  return line ? line.slice(0, 60) : null;
}

/** Total, date and shop of a receipt text (OCR of a photo) with the deterministic helpers of the research tools. */
export function receiptFacts(text: string): ReceiptFacts {
  const total = invoiceTotal(text);
  return { amount: total?.amount ?? null, amountLine: total?.line ?? null, date: findDates(text)[0]?.iso ?? null, merchant: merchantOf(text) };
}

export interface ReceiptCandidate {
  amount: number | null;
  /** YYYY-MM-DD */
  date: string;
  /** Title, persons and sender names the shop may appear in. */
  names: string[];
  text: string;
}

export interface ReceiptMatch {
  score: number;
  reasons: string[];
}

const dayDistance = (a: string, b: string) => Math.abs(Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000));
const SIMILAR_SHOP = 0.6;
const MIN_SHOP_CHARS = 4;
export const MIN_MATCH_SCORE = 50;

/** How well a receipt fits an invoice/case document: same amount (±0.01) 50 points, date within 3 days 30 (14 days 15), shop name 20; from 50 on it is a suggestion. */
export function matchReceipt(facts: ReceiptFacts, candidate: ReceiptCandidate): ReceiptMatch {
  const reasons: string[] = [];
  let score = 0;
  if (facts.amount !== null && candidate.amount !== null && Math.abs(facts.amount - candidate.amount) <= 0.01) {
    score += 50;
    reasons.push('gleicher Betrag');
  }
  const days = facts.date ? dayDistance(facts.date, candidate.date) : Infinity;
  if (days <= 14) {
    score += days <= 3 ? 30 : 15;
    reasons.push(days === 0 ? 'gleiches Datum' : `Datum ${days} Tag(e) Abstand`);
  }
  const shop = facts.merchant;
  const shopFits =
    shop !== null &&
    (candidate.names.some((name) => nameSimilarity(shop, name) >= SIMILAR_SHOP) ||
      (shop.length >= MIN_SHOP_CHARS && candidate.text.toLowerCase().includes(shop.toLowerCase())));
  if (shopFits) {
    score += 20;
    reasons.push('Händler passt');
  }
  return { score, reasons };
}
