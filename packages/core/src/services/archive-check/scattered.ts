import { truncate } from '../../util/text';
import { chooseTargetFolder, folderLabel, splitSubjects } from '../archive-structure';
import type { CheckedDocument } from './documents';
import type { CheckRun } from './findings';

type Subject = ReturnType<typeof splitSubjects>[number];
type PlacedDocument = Subject['groups'][number]['docs'][number];

/** The relocation proposal into the folder that holds most of the subject's documents, if one is clear. */
function relocation(subject: Subject) {
  const target = chooseTargetFolder(subject.groups);
  const movable = target ? subject.groups.filter((group) => group.folder !== target).flatMap((group) => group.docs) : [];
  if (!target || !movable.length) return undefined;
  const label = (document: PlacedDocument) => ({ type: 'document' as const, id: document.id, label: document.title });
  return {
    label: 'In einen Ordner verschieben',
    proposal: {
      actionType: 'relocate_documents' as const,
      label: `${movable.length} Dokument(e) zu „${subject.name}“ nach „${target}“ verschieben`,
      rationale: `Die Dokumente zu ${subject.kind} „${subject.name}“ liegen in ${subject.groups.length} Verzeichnissen; in „${target}“ liegen schon die meisten.`,
      confidence: 0.7,
      affectedEntities: movable.map(label),
      requiredConfirmation: 'confirm' as const,
      proposedParameters: {
        items: movable.map((document) => ({ documentId: document.id, categoryPath: target, fromRelPath: document.archiveRelPath ?? undefined })),
      },
    },
  };
}

const explanationOf = (subject: Subject) =>
  `${subject.groups.map((group) => `• ${folderLabel(group.folder)} (${group.docs.length}): ${group.docs.map((document) => truncate(document.title, 50)).join('; ')}`).join('\n')}\n\nDas Verschieben erfordert deine Bestätigung; nichts wird überschrieben, und es lässt sich rückgängig machen.`;

/** Documents of the same topic or project that lie in different archive directories: hint plus relocation proposal. */
export function checkScatteredDocuments(run: CheckRun, archived: CheckedDocument[]): void {
  const { deps } = run;
  const entityIds = new Map<string, string>();
  const entityName = (kind: 'topic' | 'project', id: string | null) => {
    const name = id ? (deps.graph.getEntity(id)?.name ?? null) : null;
    if (id && name) entityIds.set(`${kind}:${name.trim()}`, id);
    return name;
  };
  const placed = archived
    .filter((document) => document.status === 'archived' && document.archiveRelPath)
    .map((document) => ({
      id: document.id,
      title: document.title,
      archiveRelPath: document.archiveRelPath,
      topicName: entityName('topic', document.topicId),
      projectName: entityName('project', document.projectId),
    }));
  const keep = new Set<string>();
  for (const subject of splitSubjects(placed)) {
    const all = subject.groups.flatMap((group) => group.docs);
    // stable per topic/project; the proposal inside is replaced when the distribution changes
    const kind = subject.kind === 'Thema' ? 'topic' : 'project';
    const key = `scattered:${kind}:${entityIds.get(`${kind}:${subject.name}`) ?? subject.name}`;
    keep.add(key);
    const shown = deps.insights.upsert({
      kind: 'scattered_documents',
      title: `${subject.kind} „${subject.name}“: Dokumente liegen in ${subject.groups.length} Verzeichnissen`,
      explanation: explanationOf(subject),
      confidence: 0.8,
      affected: all.slice(0, 15).map((document) => ({ type: 'document' as const, id: document.id, label: document.title })),
      sourceIds: all.map((document) => document.id),
      action: relocation(subject),
      dedupeKey: key,
    });
    if (shown.status === 'open') run.findings.count('scattered_documents');
  }
  deps.insights.reconcile('scattered:', keep);
}
