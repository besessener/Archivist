import { normalizeName } from '../util/text';
import type { KnowledgeGraphService } from './knowledge-graph';

export interface SubjectNames {
  topic?: string | null;
  project?: string | null;
}

export interface SubjectIds {
  topicId: string | null;
  projectId: string | null;
}

/** Topic/project columns for the given names (left out = unchanged); once topic or project is given, a name used for both is the project and the topic is dropped, as after a topic-to-project merge. */
export function subjectColumns(
  graph: KnowledgeGraphService,
  names: SubjectNames,
  current: SubjectIds = { topicId: null, projectId: null },
): Partial<SubjectIds> {
  if (names.topic === undefined && names.project === undefined) return {};
  const nameOf = (given: string | null | undefined, currentId: string | null) =>
    given === undefined ? (graph.getEntity(currentId ?? '')?.name ?? '') : (given?.trim() ?? '');
  const topicName = nameOf(names.topic, current.topicId);
  const projectName = nameOf(names.project, current.projectId);
  const set: Partial<SubjectIds> = {};
  if (names.project !== undefined) set.projectId = projectName ? graph.ensureEntity({ type: 'project', name: projectName }).id : null;
  const projectId = set.projectId === undefined ? current.projectId : set.projectId;
  const isProject = Boolean(topicName) && Boolean(projectId) && normalizeName(topicName) === normalizeName(projectName);
  if (isProject) return { ...set, topicId: null };
  if (names.topic !== undefined) set.topicId = topicName ? graph.ensureEntity({ type: 'topic', name: topicName }).id : null;
  return set;
}
