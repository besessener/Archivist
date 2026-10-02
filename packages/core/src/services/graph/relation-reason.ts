import { RELATION_METHOD_LABELS, RELATION_PROVENANCE_LABELS, relationProvenance } from '@archivist/shared';
import type { GraphRelation, RelationStatus, RelationType } from '@archivist/shared';

const RELATION_LABEL: Record<RelationType, string> = {
  belongs_to: 'gehört zu',
  relates_to: 'bezieht sich auf',
  supports: 'stützt',
  contradicts: 'widerspricht',
  participated_in: 'beteiligt an',
  responsible_for: 'verantwortlich für',
  concerns: 'betrifft',
  affects: 'wirkt sich aus auf',
  supersedes: 'ersetzt',
  blocks: 'blockiert',
  results_from: 'folgt aus',
  produced: 'hat erzeugt',
  duplicate_of: 'Duplikat von',
  related_to: 'verwandt mit',
  subtopic_of: 'Unterthema von',
};

const STATUS_LABEL: Record<RelationStatus, string> = { confirmed: 'bestätigt', proposed: 'vorgeschlagen', outdated: 'veraltet', rejected: 'abgelehnt' };

/** Plain-language reason of a relation: type, status, who stands behind it, how it came about and its evidence (#270, #276). */
export function relationReason(relation: GraphRelation): string {
  const status = STATUS_LABEL[relation.status];
  const provenance = relationProvenance(relation);
  const who = relation.origin === 'agent' && provenance === 'auto' ? 'vom Agenten' : RELATION_PROVENANCE_LABELS[provenance];
  const how = relation.method && relation.method !== 'manual' ? `, ${RELATION_METHOD_LABELS[relation.method]}` : '';
  const evidence = relation.evidence ? ` – „${relation.evidence}“` : '';
  return `${RELATION_LABEL[relation.relationType] ?? relation.relationType} (${status}, ${who}${how})${evidence}`;
}
