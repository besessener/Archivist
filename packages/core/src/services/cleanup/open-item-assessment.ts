import { normalizeName } from '../../util/text';
import { hintTokens, scoreHintTokens } from '../open-item-matching';
import { numbersDiffer, titleSimilarity } from './record-merge';

/** Minimal shape compared by the detector (stored items and drafts typed in the chat). */
export interface OpenItemDraft {
  title: string;
  description?: string | null;
  topicId?: string | null;
  projectId?: string | null;
  responsiblePersonId?: string | null;
}

export interface DuplicateAssessment {
  duplicate: boolean;
  /** Title/description similarity plus agreeing details (0..~1.3). */
  score: number;
  /** Title/description similarity alone (0..1). */
  similarity: number;
  /** Details set on both sides differ (person, topic, project, numbers in the title): not the same item. */
  conflict: boolean;
  /** German reasons for the insight text, e.g. „gleicher Verantwortlicher“. */
  reasons: string[];
}

const MIN_SIMILARITY = 0.6;
const DUPLICATE_SCORE = 0.8;
const CONTEXT_FIELDS = [
  ['topicId', 'gleiches Thema'],
  ['projectId', 'gleiches Projekt'],
  ['responsiblePersonId', 'gleicher Verantwortlicher'],
] as const;

/** Same open item: similar title/description; agreeing details raise the score, differing ones set on both sides rule it out. */
export function assessOpenItemPair(a: OpenItemDraft, b: OpenItemDraft): DuplicateAssessment {
  const similarity = titleSimilarity(a, b);
  const reasons: string[] = [];
  let score = similarity;
  let conflict = numbersDiffer(a.title, b.title);
  for (const [field, label] of CONTEXT_FIELDS) {
    const valueA = a[field];
    const valueB = b[field];
    if (!valueA || !valueB) continue;
    if (valueA === valueB) {
      score += 0.1;
      reasons.push(label);
    } else conflict = true;
  }
  if (a.description?.trim() && b.description?.trim() && normalizeName(a.description) === normalizeName(b.description)) {
    score += 0.1;
    reasons.push('gleiche Beschreibung');
  }
  return { duplicate: !conflict && similarity >= MIN_SIMILARITY && score >= DUPLICATE_SCORE, score, similarity, conflict, reasons };
}

/** A short draft title that is fully contained in an existing item („Angebot Müller“ in „Angebot für Müller prüfen …“). */
const DRAFT_CONTAINED = 0.75;

/** Best existing duplicate of a chat draft, or null; a draft title found in an item counts too (the chat only asks). */
export function findOpenItemDuplicate<T extends OpenItemDraft>(draft: OpenItemDraft, items: T[]): T | null {
  const wanted = hintTokens(draft.title);
  let best: { item: T; score: number } | null = null;
  for (const item of items) {
    const a = assessOpenItemPair(draft, item);
    const contained = !a.conflict && scoreHintTokens(wanted, item) >= DRAFT_CONTAINED;
    const score = Math.max(a.duplicate ? a.score : 0, contained ? a.score + 0.1 : 0);
    if (score > 0 && (!best || score > best.score)) best = { item, score };
  }
  return best?.item ?? null;
}
