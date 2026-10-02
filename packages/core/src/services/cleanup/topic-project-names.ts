import type { GraphEntity } from '@archivist/shared';
import { normalizeName } from '../../util/text';
import type { InsightChoiceSpec, InsightService } from '../insights';
import type { KnowledgeGraphService } from '../knowledge-graph';

/** Dedupe key prefix of the „Projekt oder Thema?“ questions. */
const KEY_PREFIX = 'topic-project:';

/** Stable key of a topic/project pair: entity ids only, so the answer survives renames. */
const pairKey = (topicId: string, projectId: string): string => `${KEY_PREFIX}${[topicId, projectId].sort().join('|')}`;

type Counted = GraphEntity & { relationCount: number };

/** Topic/project pairs whose names are equal after normalization (e.g. „prod-plat“ and „Prod Plat“). */
function findTopicProjectPairs(graph: KnowledgeGraphService): Array<{ topic: Counted; project: Counted }> {
  const all = (type: 'topic' | 'project') => graph.listEntities({ type, limit: Number.MAX_SAFE_INTEGER });
  const projects = new Map<string, Counted[]>();
  for (const p of all('project')) {
    const key = normalizeName(p.name);
    if (key) projects.set(key, [...(projects.get(key) ?? []), p]);
  }
  return all('topic').flatMap((topic) => (projects.get(normalizeName(topic.name)) ?? []).map((project) => ({ topic, project })));
}

const links = (n: number) => `${n} ${n === 1 ? 'Verknüpfung' : 'Verknüpfungen'}`;

/** Archive check: asks per same-named topic/project pair which it is; „Projekt“/„Thema“ merge both (undoable). */
export function checkTopicProjectNames(deps: { graph: KnowledgeGraphService; insights: InsightService }, count: (kind: string) => void): void {
  const current = new Set<string>();
  for (const { topic, project } of findTopicProjectPairs(deps.graph)) {
    const key = pairKey(topic.id, project.id);
    current.add(key);
    const affected = [
      { type: 'topic' as const, id: topic.id, label: topic.name, detail: 'Thema' },
      { type: 'project' as const, id: project.id, label: project.name, detail: 'Projekt' },
    ];
    const mergeInto = ({ source, target }: { source: Counted; target: Counted }, { id, typeLabel }: { id: string; typeLabel: string }): InsightChoiceSpec => ({
      id,
      label: typeLabel,
      description: `Thema und Projekt werden zum ${typeLabel} „${target.name}“ zusammengeführt. Dokumente, Entscheidungen, offene Punkte, Ereignisse und Beziehungen werden übernommen. Das lässt sich rückgängig machen.`,
      proposal: {
        actionType: 'merge_entities',
        label: `„${source.name}“ und „${target.name}“ zu einem ${typeLabel} zusammenführen`,
        rationale: `Derselbe Name existiert als Thema und als Projekt; gewählt wurde „${typeLabel}“.`,
        confidence: 0.9,
        affectedEntities: affected,
        requiredConfirmation: 'confirm',
        proposedParameters: { sourceIds: [source.id], targetId: target.id, allowCrossType: true },
      },
    });
    const shown = deps.insights.upsert({
      kind: 'topic_project_name',
      title: `Ist ‚${topic.name}‘ ein Projekt oder ein Thema?`,
      explanation: `Es gibt das Thema „${topic.name}“ (${links(topic.relationCount)}) und das Projekt „${project.name}“ (${links(project.relationCount)}). Bei „Projekt“ oder „Thema“ werden beide zu einem Eintrag zusammengeführt. Bei „Beides ist richtig“ bleiben beide bestehen, und die Frage wird nicht erneut gestellt.`,
      confidence: 0.9,
      affected,
      choices: [
        mergeInto({ source: topic, target: project }, { id: 'project', typeLabel: 'Projekt' }),
        mergeInto({ source: project, target: topic }, { id: 'topic', typeLabel: 'Thema' }),
        {
          id: 'different',
          label: 'Beides ist richtig (verschieden)',
          description: 'Thema und Projekt bleiben getrennt. Diese Frage wird nicht erneut gestellt.',
        },
      ],
      dedupeKey: key,
    });
    if (shown.status === 'open') count('topic_project_name');
  }
  deps.insights.reconcile(KEY_PREFIX, current);
}
