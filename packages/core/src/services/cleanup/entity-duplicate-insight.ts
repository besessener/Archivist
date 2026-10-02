import type { EntityRef } from '@archivist/shared';
import { normalizeName } from '../../util/text';
import type { InsightChoiceSpec, InsightInput } from '../insights';
import type { DuplicateMatch } from './entity-name-matching';

/** Entity types checked for duplicates. Persons have their own check; topic↔project pairs are a separate story. */
export const CHECKED_TYPES = ['topic', 'project', 'tag'] as const;
export type CheckedType = (typeof CHECKED_TYPES)[number];

export const HINT_PREFIX = 'Hinweis des Sprachmodells: ';
export const TYPE_LABEL: Record<CheckedType, string> = { topic: 'Thema', project: 'Projekt', tag: 'Tag' };
const TYPE_PLURAL: Record<CheckedType, string> = { topic: 'Themen', project: 'Projekte', tag: 'Tags' };
const MATCH_CONFIDENCE: Record<DuplicateMatch, number> = { alias: 0.95, spelling: 0.9, plural: 0.85, typo: 0.7, prefix: 0.45 };

export interface Candidate {
  id: string;
  type: CheckedType;
  name: string;
  aliases: string[];
  createdAt: string;
}

export interface Evidence {
  documents: number;
  decisions: number;
  openItems: number;
  events: number;
  relations: number;
}

export interface Found {
  key: string;
  type: CheckedType;
  a: Candidate;
  b: Candidate;
  match: DuplicateMatch;
}

const referenceCount = (e: Evidence) => e.documents + e.decisions + e.openItems + e.events;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function describeEvidence(e: Evidence): string {
  const parts = [
    e.documents && plural(e.documents, 'Dokument', 'Dokumente'),
    e.decisions && plural(e.decisions, 'Entscheidung', 'Entscheidungen'),
    e.openItems && plural(e.openItems, 'offener Punkt', 'offene Punkte'),
    e.events && plural(e.events, 'Ereignis', 'Ereignisse'),
  ].filter(Boolean);
  if (parts.length === 0) return e.relations ? plural(e.relations, 'Verknüpfung', 'Verknüpfungen') : 'keine Verweise';
  return parts.join(', ');
}

/** Name quality for choosing the merge target when both are referenced equally often. */
function nameQuality(name: string): number {
  let quality = 0;
  if (/\p{Lu}/u.test(name)) quality += 1; // „Urlaub“ rather than „urlaub“
  if (/[äöüÄÖÜß]/.test(name)) quality += 1; // real umlauts rather than „ae/oe/ue“
  if (/_|\s{2,}|^\s|\s$/.test(name)) quality -= 1;
  return quality;
}

const MATCH_TEXT: Record<DuplicateMatch, (a: string, b: string) => string> = {
  alias: (a, b) => `„${a}“ ist bereits als anderer Name von „${b}“ bekannt.`,
  spelling: () => 'Die Namen unterscheiden sich nur in der Schreibweise (Bindestrich, Leerzeichen, Groß-/Kleinschreibung, Umlaute oder Wortreihenfolge).',
  plural: () => 'Die Namen unterscheiden sich nur in Singular und Plural.',
  typo: () => 'Die Namen unterscheiden sich nur um einen Tippfehler.',
  prefix: (a, b) => `„${b}“ beginnt mit „${a}“. Das kann dasselbe sein oder ein eigener Teilbereich – bitte entscheide.`,
};

type Side = { candidate: Candidate; evidence: Evidence };

/** Whether `first` is the merge target: more references, then the cleaner, shorter, older name. */
export function isPreferredTarget(first: Side, second: Side): boolean {
  const keys = ({ candidate, evidence }: Side) => [referenceCount(evidence), evidence.relations, nameQuality(candidate.name), -candidate.name.length];
  const keysFirst = keys(first);
  const keysSecond = keys(second);
  for (let i = 0; i < keysFirst.length; i += 1) if (keysFirst[i] !== keysSecond[i]) return keysFirst[i]! > keysSecond[i]!;
  const [a, b] = [first.candidate, second.candidate];
  return a.createdAt === b.createdAt ? a.id < b.id : a.createdAt < b.createdAt;
}

/** The pair as the insight presents it: merge target and source, shorter and longer name, and the reason. */
interface PairView {
  found: Found;
  label: string;
  target: Side;
  source: Side;
  shorter: Candidate;
  longer: Candidate;
  why: string;
  hintLine: string | undefined;
}

function whyText(found: Found, shorter: Candidate, longer: Candidate): string {
  if (found.match !== 'alias') return MATCH_TEXT[found.match](shorter.name, longer.name);
  const bIsAliasOfA = found.a.aliases.some((alias) => normalizeName(alias) === normalizeName(found.b.name));
  return bIsAliasOfA ? MATCH_TEXT.alias(found.b.name, found.a.name) : MATCH_TEXT.alias(found.a.name, found.b.name);
}

function ref(view: PairView, side: Side): EntityRef {
  return { type: view.found.type, id: side.candidate.id, label: side.candidate.name, detail: describeEvidence(side.evidence) };
}

function evidenceLines(view: PairView): string[] {
  const line = (side: Side) => `• ${view.label} „${side.candidate.name}“: ${describeEvidence(side.evidence)}`;
  return ['Belege:', line(view.target), line(view.source)];
}

function mergeProposal(view: PairView, recommendation: string) {
  return {
    actionType: 'merge_entities' as const,
    label: `${view.label} ${recommendation}`,
    rationale: view.why,
    confidence: MATCH_CONFIDENCE[view.found.match],
    affectedEntities: [ref(view, view.source), ref(view, view.target)],
    requiredConfirmation: 'confirm' as const,
    proposedParameters: { sourceIds: [view.source.candidate.id], targetId: view.target.candidate.id, allowCrossType: false },
  };
}

/** „Urlaub“ ↔ „Urlaub 2026“ (topics, projects): the longer one may be a subtopic instead (#282). */
function subtopicChoice(view: PairView): InsightChoiceSpec {
  const { shorter, longer, found } = view;
  return {
    id: 'subtopic',
    label: 'Unterthema',
    description: `„${longer.name}“ wird Unterthema von „${shorter.name}“.`,
    proposal: {
      actionType: 'link_entities',
      label: `„${longer.name}“ als Unterthema von „${shorter.name}“ einordnen`,
      rationale: view.why,
      confidence: MATCH_CONFIDENCE[found.match],
      affectedEntities: [
        { type: found.type, id: longer.id, label: longer.name },
        { type: found.type, id: shorter.id, label: shorter.name },
      ],
      requiredConfirmation: 'confirm',
      proposedParameters: { sourceId: longer.id, targetId: shorter.id, relationType: 'subtopic_of' },
    },
  };
}

function subtopicQuestion(view: PairView, recommendation: string): InsightInput {
  const { shorter, longer, found } = view;
  return {
    kind: 'similar_entities',
    title: `Gehört „${longer.name}“ zu „${shorter.name}“? (${TYPE_PLURAL[found.type]})`,
    explanation: [
      view.why,
      '',
      ...evidenceLines(view),
      '',
      `„Unterthema“ ordnet „${longer.name}“ unter „${shorter.name}“ ein – beide bleiben bestehen, Suche und Wissensfragen zu „${shorter.name}“ berücksichtigen „${longer.name}“ mit. „Zusammenführen“ macht eins daraus. Beides lässt sich rückgängig machen; „Verschieden“ wird dauerhaft gemerkt.`,
      ...(view.hintLine ? ['', view.hintLine] : []),
    ].join('\n'),
    confidence: MATCH_CONFIDENCE[found.match],
    affected: [ref(view, view.target), ref(view, view.source)],
    sourceIds: [view.target.candidate.id, view.source.candidate.id],
    choices: [
      subtopicChoice(view),
      { id: 'merge', label: 'Zusammenführen', description: recommendation, proposal: mergeProposal(view, recommendation) },
      { id: 'different', label: 'Verschieden', description: 'Wird dauerhaft gemerkt.', proposal: null },
    ],
    dedupeKey: found.key,
  };
}

function mergeQuestion(view: PairView, recommendation: string): InsightInput {
  const { found, target, source } = view;
  const reason = referenceCount(target.evidence) !== referenceCount(source.evidence) ? 'mehr Verweise' : 'klarerer Name';
  const explanation = [
    view.why,
    '',
    ...evidenceLines(view),
    '',
    `Vorschlag: „${source.candidate.name}“ in „${target.candidate.name}“ zusammenführen (${reason}). Alle Dokumente, Entscheidungen, offenen Punkte, Ereignisse und Beziehungen werden übernommen, „${source.candidate.name}“ bleibt als anderer Name erhalten. Die Zusammenführung lässt sich rückgängig machen.`,
    '„Verschieden“ merkt sich dauerhaft, dass die beiden nicht zusammengehören.',
    ...(view.hintLine ? ['', view.hintLine] : []),
  ].join('\n');
  return {
    kind: 'similar_entities',
    title:
      found.match === 'prefix'
        ? `Gehört „${view.longer.name}“ zu „${view.shorter.name}“? (${TYPE_PLURAL[found.type]})`
        : `Mögliche Dublette: ${view.label} „${found.a.name}“ und „${found.b.name}“`,
    explanation,
    confidence: MATCH_CONFIDENCE[found.match],
    affected: [ref(view, target), ref(view, source)],
    sourceIds: [target.candidate.id, source.candidate.id],
    action: { label: recommendation, proposal: mergeProposal(view, recommendation) },
    dedupeKey: found.key,
  };
}

/** Insight for a pair, with evidence and the merge proposal (proposed by the insight service only while it is open). */
export function duplicateInsight(input: {
  found: Found;
  evidence: { a: Evidence; b: Evidence };
  targetId: string;
  hintLine: string | undefined;
}): InsightInput {
  const { found, evidence } = input;
  const sideA = { candidate: found.a, evidence: evidence.a };
  const sideB = { candidate: found.b, evidence: evidence.b };
  const [target, source] = input.targetId === found.a.id ? [sideA, sideB] : [sideB, sideA];
  const [shorter, longer] = found.a.name.length <= found.b.name.length ? [found.a, found.b] : [found.b, found.a];
  const view: PairView = {
    found,
    label: TYPE_LABEL[found.type],
    target,
    source,
    shorter,
    longer,
    why: whyText(found, shorter, longer),
    hintLine: input.hintLine,
  };
  const recommendation = `„${source.candidate.name}“ in „${target.candidate.name}“ zusammenführen`;
  return found.match === 'prefix' && found.type !== 'tag' ? subtopicQuestion(view, recommendation) : mergeQuestion(view, recommendation);
}
