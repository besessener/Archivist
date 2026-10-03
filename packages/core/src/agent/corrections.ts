import type { AgentRun, AgentStep } from '@archivist/shared';
import { newId } from '../util/ids';
import { CORRECTIONS_FOR_RULE, type MemoryService } from './memory';
import type { ToolDeps } from './tools/common';

interface CorrectionDeps {
  memory: MemoryService;
  tools: Pick<ToolDeps, 'audit' | 'docs' | 'insights'>;
}

/** What the user corrected about a document the agent had worked on. */
type Correction = { kind: 'folder'; from: string; to: string } | { kind: 'topic'; to: string } | { kind: 'tag'; tag: string };

interface DocumentCorrection {
  documentId: string;
  docType: string | null;
  ext: string;
  correction: Correction;
}

const METADATA_ACTIONS = ['document.updateMetadata', 'document.assign', 'document.bulkUpdate'];

/** How a correction reads in the memory, as a rule it could become, and in the proposal. */
function describe({ docType, ext, correction }: Pick<DocumentCorrection, 'docType' | 'ext' | 'correction'>) {
  const files = docType ?? `.${ext}-Dateien`;
  const when = docType ? { docType } : { ext };
  const subject = (docType ?? ext).toLowerCase();
  if (correction.kind === 'folder')
    return {
      key: `folder:${subject}→${correction.to.toLowerCase()}`,
      did: `${docType ?? ext}-Datei nach ${correction.from} abgelegt`,
      instead: `nach ${correction.to}`,
      name: `${docType ?? `.${ext}`} → ${correction.to}`,
      files,
      rule: { when, then: { folder: correction.to } },
      target: `nach ${correction.to} legen`,
      content: `${files} immer nach ${correction.to}`,
    };
  if (correction.kind === 'topic')
    return {
      key: `topic:${subject}→${correction.to.toLowerCase()}`,
      did: `${docType ?? ext}-Datei einem anderen Thema zugeordnet`,
      instead: `Thema ${correction.to}`,
      name: `${docType ?? `.${ext}`} → Thema ${correction.to}`,
      files,
      rule: { when, then: { topic: correction.to } },
      target: `dem Thema ${correction.to} zuordnen`,
      content: `${files} immer dem Thema ${correction.to} zuordnen`,
    };
  return {
    key: `tag:${subject}→${correction.tag.toLowerCase()}`,
    did: `${docType ?? ext}-Datei ohne Schlagwort ${correction.tag} abgelegt`,
    instead: `Schlagwort ${correction.tag}`,
    name: `${docType ?? `.${ext}`} → Schlagwort ${correction.tag}`,
    files,
    rule: { when, then: { tags: [correction.tag] } },
    target: `mit dem Schlagwort ${correction.tag} versehen`,
    content: `${files} immer mit dem Schlagwort ${correction.tag} versehen`,
  };
}

/** Corrections are stored, never silently changing behaviour; repeated ones lead to a rule proposal (#315). */
export class CorrectionLearner {
  constructor(private readonly deps: CorrectionDeps) {}

  /** The user moving a document the agent had filed, or changing its topic or tags, is a correction. */
  watchUserChanges(): void {
    const { audit } = this.deps.tools;
    audit.onLog((entry) => {
      const documentId = entry.entityIds?.[0];
      if (entry.runId || entry.success === false || entry.trigger === 'agent' || !documentId) return;
      if (entry.action === 'archive.relocate' && audit.lastAgentChange(documentId, 'archive.')) this.relocated(documentId, entry);
      else if (METADATA_ACTIONS.includes(entry.action)) this.metadataChanged(entry);
    });
  }

  private relocated(documentId: string, entry: { before?: unknown; after?: unknown }): void {
    const fromFolder = (entry.before as { categoryPath?: string | null } | null)?.categoryPath ?? '';
    const toFolder = (entry.after as { categoryPath?: string | null } | null)?.categoryPath ?? '';
    const row = this.deps.tools.docs.findRow(documentId);
    if (row && toFolder && fromFolder !== toFolder)
      this.corrected({ documentId, docType: row.docType, ext: row.ext, correction: { kind: 'folder', from: fromFolder, to: toFolder } });
  }

  private metadataChanged(entry: { action: string; entityIds?: string[]; before?: unknown; after?: unknown }): void {
    const { audit, docs } = this.deps.tools;
    const before = (entry.before ?? {}) as { topicId?: string | null; tags?: string[] };
    const after = (entry.after ?? {}) as { topic?: string | null; topicId?: string | null; tags?: string[]; addTags?: string[] };
    for (const documentId of entry.entityIds ?? []) {
      if (!audit.lastAgentChange(documentId, 'document.') && !audit.lastAgentChange(documentId, 'archive.')) continue;
      const row = docs.findRow(documentId);
      if (!row) continue;
      const base = { documentId, docType: row.docType, ext: row.ext };
      const topic = docs.get(documentId).topicName;
      const topicChanged =
        entry.action === 'document.bulkUpdate' ? Boolean(after.topic?.trim()) : before.topicId !== undefined && before.topicId !== row.topicId;
      if (topic && topicChanged) this.corrected({ ...base, correction: { kind: 'topic', to: topic } });
      const added = (entry.action === 'document.bulkUpdate' ? after.addTags : after.tags?.filter((tag) => !(before.tags ?? []).includes(tag))) ?? [];
      for (const tag of added) this.corrected({ ...base, correction: { kind: 'tag', tag } });
    }
  }

  /** Undoing the whole run takes back every change it made. */
  runUndone(run: AgentRun): void {
    this.record(run.steps.filter((s) => s.outcome === 'ok' && s.risk !== 'read'));
  }

  stepUndone(run: AgentRun, stepId: string): void {
    this.record(run.steps.filter((s) => s.id === stepId));
  }

  private record(steps: AgentStep[]): void {
    for (const step of steps) this.deps.memory.recordCorrection({ did: step.label, instead: 'vom Benutzer rückgängig gemacht', key: `undo:${step.tool}` });
  }

  /** After several similar corrections the agent proposes a rule – stored only after confirmation. */
  corrected(input: DocumentCorrection): void {
    const text = describe(input);
    const count = this.deps.memory.recordCorrection({ did: text.did, instead: text.instead, key: text.key });
    if (count < CORRECTIONS_FOR_RULE) return;
    if (this.deps.memory.list('rule').some((r) => r.name === text.name)) return;
    this.deps.tools.insights.upsert({
      kind: 'learned_rule',
      title: `Soll ich ${text.files} künftig ${text.target}?`,
      explanation: `Du hast ${count}× ${text.files}, die ich bearbeitet hatte, nachträglich geändert (${text.instead}). Mit einer Regel mache ich das künftig gleich. Gespeichert wird sie erst, wenn du zustimmst.`,
      confidence: 0.7,
      affected: [{ type: 'document', id: input.documentId, label: text.name }],
      action: {
        label: 'Regel speichern',
        proposal: {
          actionType: 'agent_batch',
          label: `Regel „${text.name}“ speichern`,
          rationale: 'Aus wiederholten Korrekturen gelernt.',
          confidence: 0.7,
          affectedEntities: [],
          requiredConfirmation: 'confirm',
          proposedParameters: {
            runId: newId(),
            items: [
              {
                tool: 'remember',
                args: { kind: 'rule', name: text.name, content: text.content, rule: text.rule },
                label: `Regel „${text.name}“ speichern`,
                risk: 'write',
                reason: '',
              },
            ],
            refs: { ids: {}, sets: {} },
          },
        },
      },
      dedupeKey: `learned-rule:${text.key}`,
    });
  }
}
