import { normalizeName } from '../../util/text';
import { hintTokens, scoreHintTokens } from '../open-items';

/**
 * Building blocks for merging duplicate RECORDS (open items; notes and events can follow the same pattern):
 * keep one record, take over the details it lacks from the duplicate and mark the duplicate as discarded –
 * nothing is deleted, and the caller records the `before` values for an undo with conflict check.
 */

/**
 * How a field is taken over from the duplicate into the kept record:
 * - `fill`: only when the kept record has no value (null, undefined, empty string or empty array)
 * - `append`: text; the duplicate's text is appended on a new line unless the kept text already contains it
 * - `union`: arrays; the duplicate's entries are appended (kept entries first, no repeats)
 */
export type TakeOverRule = 'fill' | 'append' | 'union';
export type TakeOverRules<R> = { [K in keyof R]?: TakeOverRule };

export interface TakeOver<R> {
  /** Values to write into the kept record (changed fields only). */
  patch: Partial<R>;
  /** Previous values of the patched fields of the kept record (for undo). */
  before: Partial<R>;
  /** Names of the fields taken over (audit entry, insight text). */
  fields: Array<keyof R & string>;
}

const isEmpty = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && v.length === 0);

/** Appends `addition` to `current` on a new line; text that is already contained is not appended again. */
export function appendText(current: string | null | undefined, addition: string | null | undefined): string | null {
  const add = addition?.trim();
  if (!add) return current?.trim() ? current : null;
  if (!current?.trim()) return add;
  return normalizeName(current).includes(normalizeName(add)) ? current : `${current.trim()}\n${add}`;
}

/** Computes which details of `duplicate` the kept record takes over according to `rules` (pure, nothing is written). */
export function takeOverMissing<R extends object>(keep: R, duplicate: R, rules: TakeOverRules<R>): TakeOver<R> {
  const patch: Partial<R> = {};
  const before: Partial<R> = {};
  const fields: Array<keyof R & string> = [];
  for (const key of Object.keys(rules) as Array<keyof R & string>) {
    const cur = keep[key];
    const dup = duplicate[key];
    if (isEmpty(dup)) continue;
    let next: unknown = cur;
    switch (rules[key]) {
      case 'fill':
        if (isEmpty(cur)) next = dup;
        break;
      case 'append':
        next = appendText(cur as string | null, dup as string);
        break;
      case 'union': {
        const list = (cur as unknown[] | null) ?? [];
        const extra = (dup as unknown[]).filter((x) => !list.includes(x));
        if (extra.length) next = [...list, ...extra];
        break;
      }
    }
    if (next !== cur) {
      patch[key] = next as R[typeof key];
      before[key] = cur;
      fields.push(key);
    }
  }
  return { patch, before, fields };
}

/**
 * Stable insight dedupe key of a pair of records (prefix + sorted ids, never titles or scores): it survives edits and
 * renames, so rejecting the insight („Verschieden“) is remembered for good.
 */
export function duplicatePairKey(prefix: string, a: string, b: string): string {
  return `${prefix}${[a, b].sort().join('|')}`;
}

/** Of two duplicates the one recorded first is kept; the other one is discarded as its duplicate. */
export function chooseKept<T extends { id: string; createdAt: string }>(a: T, b: T): { keep: T; duplicate: T } {
  const aFirst = a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.id < b.id);
  return aFirst ? { keep: a, duplicate: b } : { keep: b, duplicate: a };
}

/**
 * Symmetric similarity (0..1) of two records by title and description: the mean of how well each title is found in
 * the other record (open-item matcher: title words count fully, description words 0.7, abbreviations and typos less).
 */
export function titleSimilarity(a: { title: string; description?: string | null }, b: { title: string; description?: string | null }): number {
  const ta = hintTokens(a.title);
  const tb = hintTokens(b.title);
  if (!ta.length || !tb.length) return normalizeName(a.title) === normalizeName(b.title) ? 1 : 0;
  return (scoreHintTokens(ta, b) + scoreHintTokens(tb, a)) / 2;
}

/** Numbers in both titles („Budget 2026“ / „Budget 2027“, „Rechnung 4711“) that differ mean different records. */
export function numbersDiffer(a: string, b: string): boolean {
  const nums = (s: string) => new Set(s.match(/\d+/g) ?? []);
  const na = nums(a);
  const nb = nums(b);
  if (!na.size || !nb.size) return false;
  return na.size !== nb.size || [...na].some((n) => !nb.has(n));
}
