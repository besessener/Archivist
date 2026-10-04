import { RELATION_METHOD_LABELS, RELATION_PROVENANCE_LABELS, RELATION_TYPE_LABELS, relationProvenance } from '@archivist/shared';
import type { GraphRelation, RelationStatus } from '@archivist/shared';

const STATUS_LABEL: Record<RelationStatus, string> = { confirmed: 'bestätigt', proposed: 'vorgeschlagen', outdated: 'veraltet', rejected: 'abgelehnt' };

/** Plain-language reason of a relation: type, status, who stands behind it, how it came about and its evidence (#270, #276). */
export function relationReason(relation: GraphRelation): string {
  const status = STATUS_LABEL[relation.status];
  const provenance = relationProvenance(relation);
  const who = relation.origin === 'agent' && provenance === 'auto' ? 'vom Agenten' : RELATION_PROVENANCE_LABELS[provenance];
  const how = relation.method && relation.method !== 'manual' ? `, ${RELATION_METHOD_LABELS[relation.method]}` : '';
  const evidence = relation.evidence ? ` – „${relation.evidence}“` : '';
  return `${RELATION_TYPE_LABELS[relation.relationType]} (${status}, ${who}${how})${evidence}`;
}
