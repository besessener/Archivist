import { isEditableOpenItemStatus, OpenItemSolution, type OpenItem, type OpenItemInput, type OpenItemPatch, type OpenItemStatus } from '@archivist/shared';
import type { openItems } from '../db/schema';
import { AppError } from '../util/errors';
import { normalizeDateInput } from '../util/dates';

export type OpenItemRow = typeof openItems.$inferSelect;

/** Closing needs `close()` with confirmation and reopening goes through undo; an edit only moves between open statuses. */
export function assertEditableStatusChange(current: OpenItemStatus, wanted: OpenItemStatus | undefined): void {
  if (wanted === undefined || wanted === current) return;
  if (!isEditableOpenItemStatus(wanted))
    throw new AppError('permission_error', 'Einen offenen Punkt als erledigt oder verworfen zu schließen, erfordert eine ausdrückliche Bestätigung.');
  if (!isEditableOpenItemStatus(current))
    throw new AppError(
      'permission_error',
      'Ein abgeschlossener Punkt lässt sich nicht durch Bearbeiten wieder öffnen. Mache das Schließen im Änderungsprotokoll rückgängig.',
    );
}

/** Columns of a patch that need no lookup (only the fields present in the patch). */
export function plainPatchColumns(current: OpenItemRow, patch: OpenItemPatch): Partial<OpenItemRow> {
  const set: Partial<OpenItemRow> = {};
  if (patch.title !== undefined) set.title = patch.title.trim();
  if (patch.description !== undefined) set.description = patch.description?.trim() || null;
  if (patch.priority) set.priority = patch.priority;
  if (patch.status && patch.status !== current.status) set.status = patch.status;
  if (patch.dueAt !== undefined) {
    set.dueAt = normalizeDateInput(patch.dueAt ?? null);
    if (set.dueAt) set.dueUnknown = false;
  }
  return set;
}

/** A new, open item from the input and its already resolved references. */
export function newOpenItemRow(
  input: OpenItemInput,
  refs: { id: string; now: string; topicId: string | null; projectId: string | null; responsiblePersonId: string | null },
): OpenItemRow {
  return {
    id: refs.id,
    title: input.title.trim(),
    description: input.description?.trim() || null,
    topicId: refs.topicId,
    projectId: refs.projectId,
    responsiblePersonId: refs.responsiblePersonId,
    responsibleUnknown: false,
    dueAt: normalizeDateInput(input.dueAt ?? null),
    dueUnknown: false,
    status: 'open',
    priority: input.priority ?? 'normal',
    sourceIds: input.sourceIds ?? [],
    reminderAt: null,
    confidence: input.confidence ?? 0.9,
    createdAt: refs.now,
    updatedAt: refs.now,
    solution: null,
    duplicateOfId: null,
    resolutionNote: null,
  };
}

export function toOpenItem(row: OpenItemRow, lookups: { nameOf: (id: string | null) => string | null; conversations: Map<string, string> }): OpenItem {
  const { nameOf, conversations } = lookups;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    topicId: row.topicId,
    topicName: nameOf(row.topicId),
    projectId: row.projectId,
    projectName: nameOf(row.projectId),
    responsiblePersonId: row.responsiblePersonId,
    responsibleName: nameOf(row.responsiblePersonId),
    responsibleUnknown: row.responsibleUnknown,
    createdAt: row.createdAt,
    dueAt: row.dueAt,
    dueUnknown: row.dueUnknown,
    status: row.status as OpenItemStatus,
    priority: row.priority as OpenItem['priority'],
    sourceIds: row.sourceIds,
    sourceConversationId: row.sourceIds.map((id) => conversations.get(id)).find(Boolean) ?? null,
    reminderAt: row.reminderAt,
    confidence: row.confidence,
    updatedAt: row.updatedAt,
    solution: row.solution ? (OpenItemSolution.safeParse(row.solution).data ?? null) : null,
    duplicateOfId: row.duplicateOfId,
    resolutionNote: row.resolutionNote,
  };
}

/** Text of the search index entry. */
export function openItemIndexContent(item: OpenItem): string {
  return [
    item.title,
    item.description,
    item.topicName && `Thema: ${item.topicName}`,
    item.projectName && `Projekt: ${item.projectName}`,
    item.responsibleName && `Verantwortlich: ${item.responsibleName}`,
    item.dueAt && `Fällig: ${item.dueAt.slice(0, 10)}`,
    `Status: ${item.status}`,
    item.resolutionNote && `${item.status === 'dismissed' ? 'Verworfen' : 'Erledigt'}: ${item.resolutionNote}`,
  ]
    .filter(Boolean)
    .join('\n');
}
