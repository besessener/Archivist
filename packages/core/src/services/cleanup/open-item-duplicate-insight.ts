import type { EntityRef, OpenItem } from '@archivist/shared';
import { truncate } from '../../util/text';
import type { InsightInput } from '../insights';
import type { DuplicateAssessment } from './open-item-assessment';

export interface DuplicatePair {
  keep: OpenItem;
  duplicate: OpenItem;
  assessment: DuplicateAssessment;
}

/** The insight offering to merge two open items that describe the same task. */
export function duplicateInsight(pair: DuplicatePair & { key: string; takenOver: string[] }): InsightInput {
  const { keep, duplicate, assessment, takenOver } = pair;
  const similarity = `Titel/Beschreibung ${Math.round(assessment.similarity * 100)} %${assessment.reasons.length ? `, ${assessment.reasons.join(', ')}` : ''}`;
  const affected: EntityRef[] = [
    { type: 'task', id: keep.id, label: keep.title },
    { type: 'task', id: duplicate.id, label: duplicate.title },
  ];
  return {
    kind: 'duplicate',
    title: `Doppelter offener Punkt: „${truncate(keep.title, 70)}“`,
    explanation: [
      `„${keep.title}“ und „${duplicate.title}“ beschreiben vermutlich dieselbe Aufgabe (${similarity}).`,
      `Vorschlag: „${keep.title}“ (zuerst erfasst) behalten${takenOver.length ? `, fehlende Angaben übernehmen (${takenOver.join(', ')})` : ''} und „${duplicate.title}“ als „verworfen (Duplikat)“ markieren.`,
      'Es wird nichts gelöscht, und die Zusammenführung lässt sich rückgängig machen. Sind es verschiedene Punkte, lehne den Hinweis ab – er erscheint dann nicht wieder.',
    ].join('\n\n'),
    confidence: Math.min(0.95, assessment.score),
    affected,
    sourceIds: [keep.id, duplicate.id],
    action: {
      proposal: {
        actionType: 'merge_open_items',
        label: `„${truncate(duplicate.title, 60)}“ als Duplikat von „${truncate(keep.title, 60)}“ verwerfen`,
        rationale: `Die offenen Punkte ähneln sich (${similarity}).`,
        confidence: Math.min(0.95, assessment.score),
        affectedEntities: affected,
        requiredConfirmation: 'confirm',
        proposedParameters: { keepId: keep.id, duplicateId: duplicate.id },
      },
      label: 'Zusammenführen',
    },
    dedupeKey: pair.key,
  };
}
