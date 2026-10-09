import type { KnowledgeAnswer, SourceReference } from '@archivist/shared';
import { sourceDateLabel } from './knowledge-sources';

/** Confidence cap when some of the model's statements had no valid source and were dropped. */
export const PARTLY_BACKED_CAP = 0.6;
/** Confidence cap when none of the model's statements has a valid source. */
export const UNBACKED_CAP = 0.3;
/** Below this confidence the answer names itself as weakly backed. */
export const LOW_CONFIDENCE = 0.5;

/** The sources an answer may cite: prompt ids (S1, S2 …) and the public form of every numbered source, in prompt order. */
export interface CitableSources {
  ids: Map<string, SourceReference>;
  stripped: SourceReference[];
}

export interface ComposedAnswer {
  content: string;
  sources: SourceReference[];
  confidence: number;
  uncertainties: string[];
}

interface CitedPoint {
  sourceIds: string[];
}

/** What the model claims, whatever the answer type: the points that need a source and its own view of what is uncertain. */
export interface ModelClaims {
  points: CitedPoint[];
  /** Further sources the model says it used. */
  alsoUsed: string[];
  confidence: number;
  uncertainties: string[];
  missingInformation: string[];
}

/** How an answer type names itself in its uncertainties. */
export type EvidenceWording = 'answer' | 'challenge';

const WORDING: Record<EvidenceWording, { lowConfidence: string; notCited: string }> = {
  answer: {
    lowConfidence: 'Die Antwort ist nur mit geringer Sicherheit belegt.',
    notCited: 'Die angezeigten Quellen wurden gefunden, aber in der Antwort nicht zitiert.',
  },
  challenge: {
    lowConfidence: 'Die Einschätzung ist nur mit geringer Sicherheit belegt.',
    notCited: 'Die angezeigten Quellen wurden gefunden, aber nicht zitiert.',
  },
};

/** The model's claims checked against the sources it may cite. */
export interface Evidence {
  isBacked: (point: CitedPoint) => boolean;
  /** The valid sources of a point as „[1][3]“. */
  citations: (sourceIds: string[]) => string;
  /** At least one point has a valid source. */
  backed: boolean;
  confidence: number;
  uncertainties: string[];
  sources: SourceReference[];
}

/** The model's own confidence, capped by how much of what it said is backed. */
export function cappedConfidence({ confidence, kept, dropped }: { confidence: number; kept: number; dropped: number }): number {
  if (!kept) return Math.min(confidence, UNBACKED_CAP);
  if (dropped) return Math.min(confidence, PARTLY_BACKED_CAP);
  return confidence;
}

/** Points without a valid source are dropped and named as uncertain; the cited sources go out in their public form only. */
export function checkEvidence(claims: ModelClaims, { citable, wording }: { citable: CitableSources; wording: EvidenceWording }): Evidence {
  const valid = (list: string[]) => list.filter((s) => citable.ids.has(s));
  const isBacked = (point: CitedPoint) => valid(point.sourceIds).length > 0;
  const backedPoints = claims.points.filter(isBacked);
  const dropped = claims.points.length - backedPoints.length;
  const confidence = cappedConfidence({ confidence: claims.confidence, kept: backedPoints.length, dropped });
  const used = new Set(valid([...claims.alsoUsed, ...backedPoints.flatMap((p) => p.sourceIds)]));
  const usedSources = citable.stripped.filter((_, i) => used.has(`S${i + 1}`));
  const uncertainties = [
    ...claims.uncertainties,
    ...claims.missingInformation.map((m) => `Fehlt: ${m}`),
    ...(dropped ? [`${dropped} Aussage(n) des Modells ohne gültigen Quellenbeleg wurden verworfen.`] : []),
    ...(confidence < LOW_CONFIDENCE ? [WORDING[wording].lowConfidence] : []),
    ...(usedSources.length ? [] : [WORDING[wording].notCited]),
  ];
  return {
    isBacked,
    citations: (list) =>
      valid(list)
        .map((s) => `[${s.replace('S', '')}]`)
        .join(''),
    backed: backedPoints.length > 0,
    confidence,
    uncertainties,
    // nothing cited: the top hits stay visible, but clearly as found, not as evidence
    sources: usedSources.length ? usedSources : citable.stripped.slice(0, 3).map((s) => ({ ...s, title: `${s.title} (gefunden, nicht zitiert)` })),
  };
}

/** The answer sections followed by the uncertainties. */
export function composeSections(parts: string[], evidence: Evidence): ComposedAnswer {
  const { uncertainties, sources, confidence } = evidence;
  const all = uncertainties.length ? [...parts, `**Unsicherheiten**\n${uncertainties.map((u) => `• ${u}`).join('\n')}`] : parts;
  return { content: all.join('\n\n'), sources, confidence, uncertainties };
}

export function localAnswer(sources: SourceReference[]): string {
  return `Ich habe ${sources.length} passende Quelle(n) gefunden (lokale Trefferliste):\n\n${sources.map((s) => `• **${s.title}** (${[s.type, sourceDateLabel(s), s.statusNote].filter(Boolean).join(', ')}): ${s.snippet}`).join('\n')}`;
}

/** The model's answer, checked against its evidence: statements without a valid source are dropped and named as uncertain. */
export function composeAnswer(answer: KnowledgeAnswer, citable: CitableSources): ComposedAnswer {
  const evidence = checkEvidence(
    {
      points: answer.facts,
      alsoUsed: answer.usedSourceIds,
      confidence: answer.confidence,
      uncertainties: answer.uncertainties,
      missingInformation: answer.missingInformation,
    },
    { citable, wording: 'answer' },
  );
  const facts = answer.facts.filter(evidence.isBacked);
  // without a single fact backed by a valid source, the model's answer text is not shown as the answer (#166)
  const parts = evidence.backed ? [answer.answer.trim()] : unbackedParts(answer);
  if (facts.length) parts.push(`**Belegte Fakten**\n${facts.map((f) => `• ${f.statement} ${evidence.citations(f.sourceIds)}`).join('\n')}`);
  if (answer.interpretation?.trim()) parts.push(`**Einschätzung (Interpretation, nicht belegt)**\n${answer.interpretation.trim()}`);
  const contradictions = answer.contradictions.filter(evidence.isBacked);
  if (contradictions.length)
    parts.push(`**Widersprüchliche Quellen**\n${contradictions.map((c) => `• ${c.description} ${evidence.citations(c.sourceIds)}`).join('\n')}`);
  return composeSections(parts, evidence);
}

function unbackedParts(answer: KnowledgeAnswer): string[] {
  const text = answer.answer.trim();
  return ['Die gefundenen Quellen belegen keine Antwort auf deine Frage.', ...(text ? [`**Nicht belegt (Einschätzung des Modells)**\n${text}`] : [])];
}
