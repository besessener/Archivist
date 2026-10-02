import type { KnowledgeAnswer, SourceReference } from '@archivist/shared';
import { sourceDateLabel } from './knowledge-sources';

/** The sources an answer may cite: prompt ids (S1, S2 …), the numbered sources and their public form. */
interface CitableSources {
  ids: Map<string, SourceReference>;
  numbered: SourceReference[];
  stripped: SourceReference[];
}

export interface ComposedAnswer {
  content: string;
  sources: SourceReference[];
  confidence: number;
  uncertainties: string[];
}

export function localAnswer(sources: SourceReference[]): string {
  return `Ich habe ${sources.length} passende Quelle(n) gefunden (lokale Trefferliste):\n\n${sources.map((s) => `• **${s.title}** (${s.type}, ${sourceDateLabel(s)}): ${s.snippet}`).join('\n')}`;
}

/** The model's answer, checked against its evidence: statements without a valid source are dropped and named as uncertain. */
export function composeAnswer(answer: KnowledgeAnswer, citable: CitableSources): ComposedAnswer {
  const valid = (list: string[]) => list.filter((s) => citable.ids.has(s));
  const citations = (list: string[]) =>
    valid(list)
      .map((s) => `[${s.replace('S', '')}]`)
      .join('');
  const facts = answer.facts.filter((f) => valid(f.sourceIds).length > 0);
  const dropped = answer.facts.length - facts.length;
  const uncertainties = [...answer.uncertainties, ...answer.missingInformation.map((m) => `Fehlt: ${m}`)];
  if (dropped) uncertainties.push(`${dropped} Aussage(n) des Modells ohne gültigen Quellenbeleg wurden verworfen.`);
  // without a single fact backed by a valid source, the model's answer text is not shown as the answer (#166)
  const backed = facts.length > 0;
  const confidence = backed ? (dropped ? Math.min(answer.confidence, 0.6) : answer.confidence) : Math.min(answer.confidence, 0.3);
  if (confidence < 0.5) uncertainties.push('Die Antwort ist nur mit geringer Sicherheit belegt.');
  const parts = backed ? [answer.answer.trim()] : unbackedParts(answer);
  if (facts.length) parts.push(`**Belegte Fakten**\n${facts.map((f) => `• ${f.statement} ${citations(f.sourceIds)}`).join('\n')}`);
  if (answer.interpretation?.trim()) parts.push(`**Einschätzung (Interpretation, nicht belegt)**\n${answer.interpretation.trim()}`);
  const contradictions = answer.contradictions.filter((c) => valid(c.sourceIds).length > 0);
  if (contradictions.length)
    parts.push(`**Widersprüchliche Quellen**\n${contradictions.map((c) => `• ${c.description} ${citations(c.sourceIds)}`).join('\n')}`);
  const used = new Set(valid([...answer.usedSourceIds, ...facts.flatMap((f) => f.sourceIds)]));
  const usedSources = citable.numbered.filter((_, i) => used.has(`S${i + 1}`));
  if (!usedSources.length) uncertainties.push('Die angezeigten Quellen wurden gefunden, aber in der Antwort nicht zitiert.');
  if (uncertainties.length) parts.push(`**Unsicherheiten**\n${uncertainties.map((u) => `• ${u}`).join('\n')}`);
  // nothing cited: the top hits stay visible, but clearly as found, not as evidence
  const sources = usedSources.length ? usedSources : citable.stripped.slice(0, 3).map((s) => ({ ...s, title: `${s.title} (gefunden, nicht zitiert)` }));
  return { content: parts.join('\n\n'), sources, confidence, uncertainties };
}

function unbackedParts(answer: KnowledgeAnswer): string[] {
  const text = answer.answer.trim();
  return ['Die gefundenen Quellen belegen keine Antwort auf deine Frage.', ...(text ? [`**Nicht belegt (Einschätzung des Modells)**\n${text}`] : [])];
}
