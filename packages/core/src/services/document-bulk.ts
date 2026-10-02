import type { DocRow } from './document-model';

/** A bulk change of document metadata; until several topics per entry exist (#287) an assignment replaces the value. */
export interface BulkPatch {
  title?: string;
  topic?: string | null;
  project?: string | null;
  /** Added (#287, #291): the main topic/project where none is set, otherwise a further one. */
  addTopic?: string;
  addProject?: string;
  /** The documents go into this case (#286). */
  caseId?: string;
  addTags?: string[];
  removeTags?: string[];
  addPersons?: string[];
  removePersons?: string[];
  docType?: string | null;
  documentDate?: string | null;
}

/** Entity ids and name sets of a bulk patch, resolved once per batch; `undefined` leaves a field as it is. */
export interface BulkTargets {
  topicId: string | null | undefined;
  projectId: string | null | undefined;
  addTopicId: string | undefined;
  addProjectId: string | undefined;
  addPersons: string[];
  removeTags: Set<string>;
  removePersons: Set<string>;
}

type ExtraLink = [string, 'relates_to' | 'belongs_to'];

interface DocumentChanges {
  set: Partial<DocRow>;
  /** Further relations, linked inside the tracked change. */
  extra: ExtraLink[];
}

/** An added topic/project becomes the main one where none is set, otherwise a further one. */
function addedSubject(current: string | null, added: { id: string; relation: ExtraLink[1] }): { main?: string; extra: ExtraLink[] } {
  if (!current) return { main: added.id, extra: [] };
  return { extra: current === added.id ? [] : [[added.id, added.relation]] };
}

type BulkBatch = { patch: BulkPatch; targets: BulkTargets };

function subjectChanges(row: DocRow, { patch, targets }: BulkBatch): DocumentChanges {
  const set: Partial<DocRow> = {};
  const extra: ExtraLink[] = [];
  if (targets.topicId !== undefined) set.topicId = targets.topicId;
  if (targets.projectId !== undefined) set.projectId = targets.projectId;
  if (targets.addTopicId && targets.topicId === undefined) {
    const added = addedSubject(row.topicId, { id: targets.addTopicId, relation: 'relates_to' });
    if (added.main) set.topicId = added.main;
    extra.push(...added.extra);
  }
  if (targets.addProjectId && targets.projectId === undefined) {
    const added = addedSubject(row.projectId, { id: targets.addProjectId, relation: 'belongs_to' });
    if (added.main) set.projectId = added.main;
    extra.push(...added.extra);
  }
  if (patch.caseId) extra.push([patch.caseId, 'belongs_to']);
  return { set, extra };
}

function listAndFieldChanges(row: DocRow, { patch, targets }: BulkBatch): Partial<DocRow> {
  const set: Partial<DocRow> = {};
  const { removeTags, removePersons, addPersons } = targets;
  if (patch.addTags?.length || removeTags.size)
    set.tags = [...new Set([...row.tags.filter((t) => !removeTags.has(t.toLowerCase())), ...(patch.addTags ?? []).map((t) => t.trim()).filter(Boolean)])];
  if (addPersons.length || removePersons.size) set.persons = [...new Set([...row.persons.filter((p) => !removePersons.has(p.toLowerCase())), ...addPersons])];
  if (patch.docType !== undefined) set.docType = patch.docType?.trim() || null;
  if (patch.documentDate !== undefined) set.documentDate = patch.documentDate?.trim() || null;
  return set;
}

/** What a bulk patch changes on one document; a title only applies when the batch has a single document. */
export function bulkChanges(row: DocRow, batch: BulkBatch & { single: boolean }): DocumentChanges {
  const { patch } = batch;
  const set: Partial<DocRow> = {};
  if (patch.title?.trim() && batch.single) set.title = patch.title.trim().slice(0, 200);
  const subjects = subjectChanges(row, batch);
  return { set: { ...set, ...subjects.set, ...listAndFieldChanges(row, batch) }, extra: subjects.extra };
}
