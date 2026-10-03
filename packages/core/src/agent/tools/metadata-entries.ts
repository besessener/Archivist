import type { GraphEntity } from '@archivist/shared';
import { truncate } from '../../util/text';
import { TYPE_LABEL, type ToolDeps } from './common';

/** The change of a `set_metadata` call for decisions, open items and events (#305); `date` undefined: unchanged, null: removed. */
export interface EntryChange {
  title: string | null;
  topic?: string | null;
  project?: string | null;
  addPersons: string[];
  removePersons?: string[] | null;
  date: string | null | undefined;
}

const samePerson = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Participants after adding and removing names; no key when nothing changes. */
function mergePersons(current: string[], change: EntryChange): { participants?: string[] } {
  const remove = change.removePersons ?? [];
  if (!change.addPersons.length && !remove.length) return {};
  const kept = current.filter((p) => !remove.some((r) => samePerson(r, p)));
  return { participants: [...kept, ...change.addPersons.filter((p) => !kept.some((k) => samePerson(k, p)))] };
}

const commonFields = (change: EntryChange) => ({
  ...(change.title ? { title: change.title } : {}),
  ...(change.topic !== undefined ? { topic: change.topic } : {}),
  ...(change.project !== undefined ? { project: change.project } : {}),
});

type EntryPatch =
  | { kind: 'decision'; fields: Parameters<ToolDeps['decisions']['update']>[1]['patch'] }
  | { kind: 'openItem'; fields: Parameters<ToolDeps['openItems']['update']>[1]['patch'] }
  | { kind: 'event'; fields: Parameters<ToolDeps['events']['update']>[1]['patch'] }
  | { kind: 'none' };

function decisionPatch(deps: ToolDeps, entry: { id: string; change: EntryChange }): EntryPatch {
  const { change } = entry;
  const fields = {
    ...commonFields(change),
    ...(change.date !== undefined ? { decidedAt: change.date } : {}),
    ...mergePersons(deps.decisions.get(entry.id).participants, change),
  };
  return { kind: 'decision', fields };
}

function openItemPatch(deps: ToolDeps, entry: { id: string; change: EntryChange }): EntryPatch {
  const { change } = entry;
  const current = deps.openItems.get(entry.id);
  const responsibleRemoved = current.responsibleName && change.removePersons?.some((p) => samePerson(p, current.responsibleName!));
  const responsible = change.addPersons[0] ?? (responsibleRemoved ? null : undefined);
  const fields = {
    ...commonFields(change),
    ...(change.date !== undefined ? { dueAt: change.date } : {}),
    ...(responsible !== undefined ? { responsible } : {}),
  };
  return { kind: 'openItem', fields };
}

function eventPatch(deps: ToolDeps, entry: { id: string; change: EntryChange }): EntryPatch {
  const { change } = entry;
  const merged = mergePersons(deps.events.get(entry.id).participants, change);
  const fields = {
    ...commonFields(change),
    ...(change.date ? { occurredAt: change.date } : {}),
    ...(merged.participants ? { participants: merged.participants } : {}),
  };
  return { kind: 'event', fields };
}

function entryPatch(deps: ToolDeps, entry: { entity: GraphEntity; change: EntryChange }): EntryPatch {
  const { entity, change } = entry;
  if (entity.type === 'decision') return decisionPatch(deps, { id: entity.id, change });
  if (entity.type === 'task' || entity.type === 'question') return openItemPatch(deps, { id: entity.id, change });
  if (entity.type === 'event') return eventPatch(deps, { id: entity.id, change });
  return { kind: 'none' };
}

function savePatch(deps: ToolDeps, entry: { id: string; patch: EntryPatch }): void {
  const { id, patch } = entry;
  if (patch.kind === 'decision') deps.decisions.update(id, { patch: patch.fields, trigger: 'agent' });
  else if (patch.kind === 'openItem') deps.openItems.update(id, { patch: patch.fields, trigger: 'agent' });
  else if (patch.kind === 'event') deps.events.update(id, { patch: patch.fields, trigger: 'agent' });
}

const isEmpty = (patch: EntryPatch) => patch.kind === 'none' || !Object.keys(patch.fields).length;

/** Title, topic, project, persons and date of decisions, open items and events; other entries are left alone. */
export function updateEntries(deps: ToolDeps, update: { ids: string[]; change: EntryChange }): { changed: string[] } | { error: string } {
  const changed: string[] = [];
  for (const id of update.ids) {
    const entity = deps.graph.getEntity(id);
    if (!entity) continue;
    if (entity.type === 'event' && update.change.date === null) return { error: 'Ein Ereignis braucht ein Datum – es kann nicht entfernt werden.' };
    const patch = entryPatch(deps, { entity, change: update.change });
    if (isEmpty(patch)) continue;
    savePatch(deps, { id, patch });
    changed.push(`${TYPE_LABEL[entity.type] ?? entity.type} „${truncate(entity.name, 40)}“`);
  }
  return { changed };
}
