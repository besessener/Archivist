import type { Decision } from '@archivist/shared';
import { normalizeName } from '../util/text';

const SETTLED_STATUSES = new Set(['superseded', 'revoked']);

/** An existing, still relevant decision with the same text (ignoring case, punctuation and diacritics) on the same topic; a settled one may be decided again. */
export function findDecisionDuplicate(candidate: { decisionText: string; topic?: string | null }, existing: Decision[]): Decision | undefined {
  const text = normalizeName(candidate.decisionText);
  if (!text) return undefined;
  const topic = normalizeName(candidate.topic ?? '');
  return existing.find(
    (decision) => !SETTLED_STATUSES.has(decision.status) && normalizeName(decision.decisionText) === text && normalizeName(decision.topicName ?? '') === topic,
  );
}
