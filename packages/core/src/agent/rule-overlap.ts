import type { RuleDefinition } from '@archivist/shared';
import { normalizeName } from '../util/text';

type Condition = RuleDefinition['when'];
const CONDITIONS = ['sender', 'docType', 'nameContains', 'ext', 'topic', 'textContains'] as const;

const clean = (value: string | null | undefined) => normalizeName(value ?? '');

/** Could one document match both conditions? Fields only one rule names do not exclude each other. */
export function conditionsOverlap(a: Condition, b: Condition): boolean {
  return CONDITIONS.every((field) => {
    const [x, y] = [clean(a[field]), clean(b[field])];
    if (!x || !y) return true;
    return field === 'ext' ? x === y : x.includes(y) || y.includes(x);
  });
}

/** What the two rules would do differently with the same document; null when they agree or never meet. */
export function ruleClash(existing: RuleDefinition, added: RuleDefinition): string | null {
  if (!conditionsOverlap(existing.when, added.when)) return null;
  const folder = (r: RuleDefinition) => r.then.folder?.trim().toLowerCase();
  const topic = (r: RuleDefinition) => r.then.topic?.trim();
  if (folder(existing) && folder(added) && folder(existing) !== folder(added)) return `Ordner ${folder(existing)} statt ${folder(added)}`;
  if (topic(existing) && topic(added) && topic(existing) !== topic(added)) return `Thema ${topic(existing)} statt ${topic(added)}`;
  return null;
}
