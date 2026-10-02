import { normalizeName } from '../../util/text';
import { hintTokens, scoreHintTokens } from '../open-item-matching';

/** How a field is taken over: `fill` only into an empty value, `append` text on a new line, `union` array entries. */
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

/** The kept value after taking over `offered` by `rule`; the kept value itself when nothing changes. */
function takenOverValue(rule: TakeOverRule | undefined, { kept, offered }: { kept: unknown; offered: unknown }): unknown {
  if (isEmpty(offered)) return kept;
  switch (rule) {
    case 'fill':
      return isEmpty(kept) ? offered : kept;
    case 'append':
      return appendText(kept as string | null, offered as string);
    case 'union': {
      const list = (kept as unknown[] | null) ?? [];
      const extra = (offered as unknown[]).filter((entry) => !list.includes(entry));
      return extra.length ? [...list, ...extra] : kept;
    }
    default:
      return kept;
  }
}

/** Computes which details of `duplicate` the kept record takes over according to `rules` (pure, nothing is written). */
export function takeOverMissing<R extends object>({ keep, duplicate }: { keep: R; duplicate: R }, rules: TakeOverRules<R>): TakeOver<R> {
  const patch: Partial<R> = {};
  const before: Partial<R> = {};
  const fields: Array<keyof R & string> = [];
  for (const key of Object.keys(rules) as Array<keyof R & string>) {
    const kept = keep[key];
    const next = takenOverValue(rules[key], { kept, offered: duplicate[key] });
    if (next !== kept) {
      patch[key] = next as R[typeof key];
      before[key] = kept;
      fields.push(key);
    }
  }
  return { patch, before, fields };
}

/** Stable insight key of a pair (prefix + sorted ids, never titles), so a rejection („Verschieden“) survives renames. */
export function duplicatePairKey(prefix: string, ids: [string, string]): string {
  return `${prefix}${[...ids].sort().join('|')}`;
}

/** Of two duplicates the one recorded first is kept; the other one is discarded as its duplicate. */
export function chooseKept<T extends { id: string; createdAt: string }>(a: T, b: T): { keep: T; duplicate: T } {
  const aFirst = a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.id < b.id);
  return aFirst ? { keep: a, duplicate: b } : { keep: b, duplicate: a };
}

/** Symmetric similarity (0..1): the mean of how well each title is found in the other record (open-item matcher). */
export function titleSimilarity(a: { title: string; description?: string | null }, b: { title: string; description?: string | null }): number {
  const tokensA = hintTokens(a.title);
  const tokensB = hintTokens(b.title);
  if (!tokensA.length || !tokensB.length) return normalizeName(a.title) === normalizeName(b.title) ? 1 : 0;
  return (scoreHintTokens(tokensA, b) + scoreHintTokens(tokensB, a)) / 2;
}

/** Numbers in both titles („Budget 2026“ / „Budget 2027“, „Rechnung 4711“) that differ mean different records. */
export function numbersDiffer(a: string, b: string): boolean {
  const numbersIn = (s: string) => new Set(s.match(/\d+/g) ?? []);
  const numbersA = numbersIn(a);
  const numbersB = numbersIn(b);
  if (!numbersA.size || !numbersB.size) return false;
  return numbersA.size !== numbersB.size || [...numbersA].some((n) => !numbersB.has(n));
}
