import {
  DECISION_STATUS_LABELS,
  isEditableDecisionStatus,
  type Decision,
  type DecisionField,
  type DecisionOrigin,
  type DecisionPatch,
  type DecisionStatus,
} from '@archivist/shared';
import type { decisions } from '../db/schema';
import { AppError } from '../util/errors';
import { normalizeDateInput } from '../util/dates';
import { normalizeName, truncate } from '../util/text';

export type DecisionRow = typeof decisions.$inferSelect;

const CONFIRMED_UNKNOWN = 'unbekannt (bestätigt)';

/** Decision date as ISO; a decision cannot have been taken after `today` (#168). */
export function checkedDecisionDate(value: string | null | undefined, today: string): string | null {
  const iso = normalizeDateInput(value ?? null);
  if (iso && iso.slice(0, 10) > today)
    throw new AppError('validation_error', `Das Entscheidungsdatum ${iso.slice(0, 10)} liegt in der Zukunft. Gib das Datum an, an dem entschieden wurde.`);
  return iso;
}

/** Required fields (when, topic, decision; participants are optional for a private archive, #198) that are neither present nor confirmed as unknown. */
export function computeMissingFields(d: {
  decisionText?: string | null;
  decidedAt?: string | null;
  topic?: string | null;
  unknownFields?: DecisionField[];
}): DecisionField[] {
  const unknown = new Set(d.unknownFields ?? []);
  const missing: DecisionField[] = [];
  if (!d.decidedAt && !unknown.has('decidedAt')) missing.push('decidedAt');
  if (!d.topic?.trim() && !unknown.has('topic')) missing.push('topic');
  if (!d.decisionText?.trim() && !unknown.has('decisionText')) missing.push('decisionText');
  return missing;
}

/** Targeted follow-up questions per missing required field. */
export function questionFor(field: DecisionField, ctx: { topic?: string | null } = {}): string {
  switch (field) {
    case 'decidedAt':
      return 'Wann wurde das entschieden?';
    case 'participants':
      return 'Wer war an der Entscheidung beteiligt?';
    case 'topic':
      return 'Zu welchem Thema gehört die Entscheidung?';
    case 'decisionText':
      return ctx.topic ? `Was genau wurde zu „${ctx.topic}“ entschieden?` : 'Was genau wurde entschieden?';
  }
}

/** Superseding and revoking need their confirmed actions; an edit may only move between the editable statuses. */
export function assertEditableStatusChange(current: DecisionStatus, wanted: DecisionStatus | undefined): void {
  if (wanted === undefined || wanted === current) return;
  if (!isEditableDecisionStatus(wanted))
    throw new AppError('permission_error', 'Ersetzen und Widerrufen einer Entscheidung gehen nur über die jeweilige Aktion mit ausdrücklicher Bestätigung.');
  if (!isEditableDecisionStatus(current))
    throw new AppError(
      'permission_error',
      'Eine ersetzte oder widerrufene Entscheidung lässt sich nicht durch Bearbeiten wieder in Kraft setzen. Mache das Ersetzen bzw. Widerrufen im Änderungsprotokoll rückgängig.',
    );
}

/** The status after an edit: the wanted one, or `active` once a draft has all required fields; unchanged otherwise. */
export function statusAfterEdit(current: DecisionStatus, edit: { patch: DecisionPatch; missing: DecisionField[] }): DecisionStatus | undefined {
  const { patch, missing } = edit;
  if (patch.status && patch.status !== current) return patch.status;
  if (!patch.status && current === 'draft' && missing.length === 0 && !patch.asDraft) return 'active';
  return undefined;
}

/** Text columns of a patch that need no lookup (only the fields present in the patch). */
export function plainPatchColumns(current: DecisionRow, patch: DecisionPatch): Partial<DecisionRow> {
  const set: Partial<DecisionRow> = {};
  if (patch.title !== undefined) set.title = patch.title.trim() || current.title;
  if (patch.decisionText !== undefined) set.decisionText = patch.decisionText.trim();
  if (patch.rationale !== undefined) set.rationale = patch.rationale?.trim() || null;
  if (patch.consequences !== undefined) set.consequences = patch.consequences?.trim() || null;
  if (patch.alternatives !== undefined) set.alternatives = patch.alternatives;
  if (patch.validFrom !== undefined) set.validFrom = normalizeDateInput(patch.validFrom ?? null);
  if (patch.validUntil !== undefined) set.validUntil = normalizeDateInput(patch.validUntil ?? null);
  if (patch.sourceIds !== undefined) set.sourceIds = [...new Set([...current.sourceIds, ...patch.sourceIds])];
  if (patch.unknownFields !== undefined) set.unknownFields = [...new Set(patch.unknownFields)];
  return set;
}

export function toDecision(row: DecisionRow, nameOf: (id: string | null) => string | null, supersededBy: Decision['supersededBy'] = []): Decision {
  return {
    id: row.id,
    title: row.title,
    decisionText: row.decisionText,
    decidedAt: row.decidedAt,
    topicId: row.topicId,
    topicName: nameOf(row.topicId),
    projectId: row.projectId,
    projectName: nameOf(row.projectId),
    participants: row.participants,
    rationale: row.rationale,
    consequences: row.consequences,
    alternatives: row.alternatives,
    status: row.status as DecisionStatus,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    supersedesDecisionId: row.supersedesDecisionId,
    supersededBy,
    sourceIds: row.sourceIds,
    confidence: row.confidence,
    missingFields: row.missingFields as DecisionField[],
    origin: (row.origin as DecisionOrigin | null) ?? null,
    evidence: row.evidence,
    unknownFields: row.unknownFields as DecisionField[],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function orUnknown(d: Decision, { field, value }: { field: DecisionField; value: string | null }): string {
  if (value !== null) return value;
  return d.unknownFields.includes(field) ? CONFIRMED_UNKNOWN : 'offen';
}

const validityLine = (d: Decision): string[] =>
  d.validFrom || d.validUntil
    ? [`**Gültig:** ${[d.validFrom && `ab ${d.validFrom.slice(0, 10)}`, d.validUntil && `bis ${d.validUntil.slice(0, 10)}`].filter(Boolean).join(' ')}`]
    : [];

/** Human-readable rendering (when/topic/participants/…). */
export function formatDecision(d: Decision): string {
  const project = d.projectName && d.projectName !== d.topicName ? ` (Projekt: ${d.projectName})` : '';
  return [
    `**Wann:** ${orUnknown(d, { field: 'decidedAt', value: d.decidedAt ? d.decidedAt.slice(0, 10) : null })}`,
    ...validityLine(d),
    `**Thema:** ${orUnknown(d, { field: 'topic', value: d.topicName })}${project}`,
    `**Beteiligte:** ${orUnknown(d, { field: 'participants', value: d.participants.length ? d.participants.join(', ') : null })}`,
    `**Entscheidung:** ${d.decisionText}`,
    `**Begründung:** ${d.rationale ?? '–'}`,
    `**Auswirkungen:** ${d.consequences ?? '–'}`,
    `**Alternativen:** ${d.alternatives.length ? d.alternatives.join('; ') : '–'}`,
    `**Status:** ${DECISION_STATUS_LABELS[d.status]}`,
    ...(d.supersededBy.length ? [`**Ersetzt durch:** ${d.supersededBy.map((successor) => successor.title).join('; ')}`] : []),
    `**Sicherheit:** ${Math.round(d.confidence * 100)} %`,
  ].join('\n');
}

/** Text of the search index entry. */
export function decisionIndexContent(d: Decision): string {
  return [
    d.decisionText,
    d.topicName && `Thema: ${d.topicName}`,
    d.projectName && `Projekt: ${d.projectName}`,
    d.decidedAt && `Datum: ${d.decidedAt.slice(0, 10)}`,
    d.participants.length ? `Beteiligte: ${d.participants.join(', ')}` : '',
    d.rationale && `Begründung: ${d.rationale}`,
    d.consequences && `Auswirkungen: ${d.consequences}`,
    `Status: ${DECISION_STATUS_LABELS[d.status]}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function decisionSummary(d: Decision): string {
  return `${d.decidedAt ? d.decidedAt.slice(0, 10) : 'ohne Datum'}: ${truncate(d.title, 80)}${d.topicName ? ` [${d.topicName}]` : ''} (${normalizeName(d.status)})`;
}
