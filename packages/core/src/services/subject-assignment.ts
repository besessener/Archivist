import type { EntityType, GraphEntity, RelationType } from '@archivist/shared';

/** Undo data of a main topic/project a bulk assignment set (#291). */
export interface MainUndo {
  table: string;
  col: 'topic_id' | 'project_id';
  id: string;
  value: string;
}

/** Undo data of the tags a bulk assignment added to a document (#291); `added` are the tags this assignment added. */
export interface TagUndo {
  id: string;
  before: string[];
  added: string[];
}

export interface LinkSpec {
  sourceId: string;
  targetId: string;
  relationType: RelationType;
}

export type SubjectKind = 'topic' | 'project';

export interface MainSubjects {
  topicId: string | null;
  projectId: string | null;
}

export interface BulkPatch {
  topics?: string[];
  projects?: string[];
  tags?: string[];
}

/** Lookups the planner needs; resolving a name may create the topic, project or tag. */
export interface BulkPlanSources {
  resolve(kind: SubjectKind | 'tag', name: string): string;
  mainOf(id: string, type: EntityType): MainSubjects;
  documentTags(id: string): string[];
}

type Entry = Pick<GraphEntity, 'id' | 'type'>;

/** The table of each kind of entry that has a main topic/project column. */
export const SUBJECT_TABLE: Partial<Record<EntityType, string>> = {
  document: 'documents',
  decision: 'decisions',
  task: 'open_items',
  question: 'open_items',
  event: 'events',
};

/** The relation an entry has to a topic or project – the same the field mirror of the main column uses. */
export function subjectRelation(entryType: EntityType, subject: SubjectKind): RelationType {
  if (entryType === 'decision') return subject === 'topic' ? 'concerns' : 'affects';
  return subject === 'topic' ? 'relates_to' : 'belongs_to';
}

/** Trimmed, non-empty, distinct names. */
function cleanNames(names: string[] | undefined): string[] {
  return [...new Set((names ?? []).map((name) => name.trim()).filter(Boolean))];
}

/** What a bulk assignment writes: main columns, document tags, field mirrors and added relations. */
export class BulkAssignmentPlan {
  readonly main: MainUndo[] = [];
  readonly tags: TagUndo[] = [];
  readonly mirrors: LinkSpec[] = [];
  readonly add: LinkSpec[] = [];
  readonly touched = new Set<string>();
  /** A main value set earlier in this plan counts: the second topic of an entry without one becomes a further one. */
  private readonly plannedMain = new Map<string, string>();

  constructor(
    private readonly sources: BulkPlanSources,
    private readonly entries: Entry[],
  ) {}

  assignSubject(kind: SubjectKind, name: string): void {
    const targetId = this.sources.resolve(kind, name);
    for (const entry of this.entries) this.assignSubjectTo(entry, kind, targetId);
  }

  assignTag(name: string): void {
    const tagId = this.sources.resolve('tag', name);
    for (const entry of this.entries) {
      if (entry.type !== 'document') this.add.push({ sourceId: entry.id, targetId: tagId, relationType: 'relates_to' });
      else if (!this.addDocumentTag(entry.id, name, tagId)) continue;
      this.touched.add(entry.id);
    }
  }

  assignCase(caseId: string): void {
    for (const entry of this.entries.filter((candidate) => candidate.type !== 'case')) {
      this.add.push({ sourceId: entry.id, targetId: caseId, relationType: 'belongs_to' });
      this.touched.add(entry.id);
    }
  }

  private assignSubjectTo(entry: Entry, kind: SubjectKind, targetId: string): void {
    const table = SUBJECT_TABLE[entry.type];
    const link = { sourceId: entry.id, targetId, relationType: subjectRelation(entry.type, kind) };
    const current = table ? this.currentMain(entry, kind) : null;
    if (current === targetId) return;
    if (table && !current) {
      this.plannedMain.set(`${entry.id}:${kind}`, targetId);
      this.main.push({ table, col: kind === 'topic' ? 'topic_id' : 'project_id', id: entry.id, value: targetId });
      this.mirrors.push(link);
    } else this.add.push(link);
    this.touched.add(entry.id);
  }

  private currentMain(entry: Entry, kind: SubjectKind): string | null {
    const planned = this.plannedMain.get(`${entry.id}:${kind}`);
    if (planned) return planned;
    const main = this.sources.mainOf(entry.id, entry.type);
    return kind === 'topic' ? main.topicId : main.projectId;
  }

  /** Adds the tag to a document unless it already carries it (case-insensitive); returns whether it was added. */
  private addDocumentTag(documentId: string, name: string, tagId: string): boolean {
    const tagUndo = this.tagUndoOf(documentId);
    if ([...tagUndo.before, ...tagUndo.added].some((tag) => tag.toLowerCase() === name.toLowerCase())) return false;
    tagUndo.added.push(name);
    this.mirrors.push({ sourceId: documentId, targetId: tagId, relationType: 'relates_to' });
    return true;
  }

  private tagUndoOf(documentId: string): TagUndo {
    const existing = this.tags.find((tagUndo) => tagUndo.id === documentId);
    if (existing) return existing;
    const created: TagUndo = { id: documentId, before: this.sources.documentTags(documentId), added: [] };
    this.tags.push(created);
    return created;
  }
}

/** Plans a bulk assignment in the order topics, projects, tags, case – resolving names in that order. */
export function planBulkAssignment(sources: BulkPlanSources, input: { entries: Entry[]; patch: BulkPatch; caseId: string | null }): BulkAssignmentPlan {
  const plan = new BulkAssignmentPlan(sources, input.entries);
  for (const name of cleanNames(input.patch.topics)) plan.assignSubject('topic', name);
  for (const name of cleanNames(input.patch.projects)) plan.assignSubject('project', name);
  for (const name of cleanNames(input.patch.tags)) plan.assignTag(name);
  if (input.caseId) plan.assignCase(input.caseId);
  return plan;
}
