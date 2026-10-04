import type { Decision } from '@archivist/shared';
import { normalizeName } from '../util/text';

const SETTLED_STATUSES = new Set(['superseded', 'revoked']);

/** Topic and project as they are stored: a topic named like the project is dropped. */
function subjectKey(topic: string | null | undefined, project: string | null | undefined): string {
  const projectKey = normalizeName(project ?? '');
  const topicKey = normalizeName(topic ?? '');
  return `${topicKey === projectKey ? '' : topicKey}|${projectKey}`;
}

/** An existing, still relevant decision with the same text (ignoring case, punctuation and diacritics) on the same topic and project; a settled one may be decided again. */
export function findDecisionDuplicate(
  candidate: { decisionText: string; topic?: string | null; project?: string | null },
  existing: Decision[],
): Decision | undefined {
  const text = normalizeName(candidate.decisionText);
  if (!text) return undefined;
  const subject = subjectKey(candidate.topic, candidate.project);
  return existing.find(
    (decision) =>
      !SETTLED_STATUSES.has(decision.status) &&
      normalizeName(decision.decisionText) === text &&
      subjectKey(decision.topicName, decision.projectName) === subject,
  );
}
