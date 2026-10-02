import type { EntityRef } from '@archivist/shared';
import type { entities, events } from '../../db/schema';
import { truncate } from '../../util/text';
import type { InsightActionSpec, InsightInput } from '../insights';
import { words, type EventPairAssessment, type NotePairAssessment } from './note-event-assessment';

export type EntityRow = typeof entities.$inferSelect;
export type EventRow = typeof events.$inferSelect;

export const noteText = (note: Pick<EntityRow, 'name' | 'description'>) => note.description ?? note.name;

const NOT_DELETED = 'Es wird nichts gelöscht, und die Zusammenführung lässt sich rückgängig machen.';

function howNotesMatch(assessment: NotePairAssessment): string {
  if (assessment.match === 'identical') return 'haben denselben Inhalt';
  if (assessment.match === 'similar') return 'enthalten dieselben Wörter (bis auf Reihenfolge, Satzzeichen oder Tippfehler)';
  return `sind nahezu gleich (${Math.round(assessment.similarity * 100)} % gemeinsame Wörter)`;
}

function mergeAction(input: { actionType: 'merge_notes' | 'merge_events'; label: string; rationale: string; confidence: number; affected: EntityRef[] }) {
  const [keep, duplicate] = input.affected as [EntityRef, EntityRef];
  return {
    label: 'Zusammenführen',
    proposal: {
      actionType: input.actionType,
      label: input.label,
      rationale: input.rationale,
      confidence: input.confidence,
      affectedEntities: input.affected,
      requiredConfirmation: 'confirm',
      proposedParameters: { keepId: keep.id, duplicateId: duplicate.id },
    },
  } satisfies InsightActionSpec;
}

/** Insight with the merge proposal for a pair of duplicate notes; `missingLinks` counts the links the kept note lacks. */
export function noteInsight(pair: { keep: EntityRow; duplicate: EntityRow; assessment: NotePairAssessment; key: string; missingLinks: number }): InsightInput {
  const { keep, duplicate, assessment, missingLinks } = pair;
  const how = howNotesMatch(assessment);
  const affected: EntityRef[] = [
    { type: 'note', id: keep.id, label: keep.name },
    { type: 'note', id: duplicate.id, label: duplicate.name },
  ];
  const confidence = assessment.match === 'identical' ? 0.95 : 0.8;
  const kept = words(noteText(keep)).length > words(noteText(duplicate)).length ? 'ausführlichere' : 'zuerst erfasste';
  return {
    kind: 'duplicate',
    title: `Doppelte Notiz: „${truncate(keep.name, 70)}“`,
    explanation: [
      `Zwei Notizen ${how}:\n• ${truncate(noteText(keep), 200)}\n• ${truncate(noteText(duplicate), 200)}`,
      `Vorschlag: die ${kept} Notiz „${truncate(keep.name, 70)}“ behalten${missingLinks ? `, ${missingLinks} fehlende Verknüpfung(en) übernehmen` : ''} und die andere als „verworfen (Duplikat)“ markieren.`,
      `${NOT_DELETED} Sind es verschiedene Notizen, lehne den Hinweis ab – er erscheint dann nicht wieder.`,
    ].join('\n\n'),
    confidence,
    affected,
    sourceIds: [keep.id, duplicate.id],
    action: mergeAction({
      actionType: 'merge_notes',
      label: `Notiz „${truncate(duplicate.name, 60)}“ als Duplikat verwerfen`,
      rationale: `Die beiden Notizen ${how}.`,
      confidence,
      affected,
    }),
    dedupeKey: pair.key,
  };
}

/** Insight with the merge proposal for a pair of duplicate events; `takenOver` labels what the kept event would take over. */
export function eventInsight(pair: { keep: EventRow; duplicate: EventRow; assessment: EventPairAssessment; key: string; takenOver: string[] }): InsightInput {
  const { keep, duplicate, assessment, takenOver } = pair;
  const day = keep.occurredAt.slice(0, 10);
  const reasons = assessment.reasons.length ? `, ${assessment.reasons.join(', ')}` : '';
  const why = `Gleiches Datum (${day}), ähnlicher Titel (${Math.round(assessment.similarity * 100)} %)${reasons}.`;
  const affected: EntityRef[] = [
    { type: 'event', id: keep.id, label: keep.title },
    { type: 'event', id: duplicate.id, label: duplicate.title },
  ];
  const confidence = Math.min(0.95, 0.5 + assessment.similarity * 0.4 + assessment.reasons.length * 0.05);
  return {
    kind: 'duplicate',
    title: `Doppeltes Ereignis: „${truncate(keep.title, 70)}“ (${day})`,
    explanation: [
      `„${keep.title}“ und „${duplicate.title}“ beschreiben vermutlich dasselbe Ereignis. ${why}`,
      `Vorschlag: „${keep.title}“ (zuerst erfasst) behalten${takenOver.length ? `, fehlende Angaben übernehmen (${takenOver.join(', ')})` : ''} und „${duplicate.title}“ als „verworfen (Duplikat)“ markieren.`,
      `${NOT_DELETED} Sind es verschiedene Ereignisse, lehne den Hinweis ab – er erscheint dann nicht wieder.`,
    ].join('\n\n'),
    confidence,
    affected,
    sourceIds: [keep.id, duplicate.id],
    action: mergeAction({
      actionType: 'merge_events',
      label: `„${truncate(duplicate.title, 60)}“ als Duplikat von „${truncate(keep.title, 60)}“ verwerfen`,
      rationale: why,
      confidence,
      affected,
    }),
    dedupeKey: pair.key,
  };
}
