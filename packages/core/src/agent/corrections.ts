import type { AgentRun, AgentStep } from '@archivist/shared';
import { newId } from '../util/ids';
import { CORRECTIONS_FOR_RULE, type MemoryService } from './memory';
import type { ToolDeps } from './tools/common';

/** The user moved a document the agent had filed (archive folders). */
export interface UserRelocation {
  documentId: string;
  fromFolder: string;
  toFolder: string;
  docType: string | null;
  ext: string;
}

interface CorrectionDeps {
  memory: MemoryService;
  tools: Pick<ToolDeps, 'audit' | 'docs' | 'insights'>;
}

/** Corrections are stored, never silently changing behaviour; repeated ones lead to a rule proposal (#315). */
export class CorrectionLearner {
  constructor(private readonly deps: CorrectionDeps) {}

  /** The user moving a document the agent had filed is a correction. */
  watchRelocations(): void {
    const { audit, docs } = this.deps.tools;
    audit.onLog((entry) => {
      const documentId = entry.entityIds?.[0];
      if (entry.action !== 'archive.relocate' || entry.runId || entry.success === false || entry.trigger === 'agent' || !documentId) return;
      if (!audit.lastAgentChange(documentId, 'archive.')) return;
      const fromFolder = (entry.before as { categoryPath?: string | null } | null)?.categoryPath ?? '';
      const toFolder = (entry.after as { categoryPath?: string | null } | null)?.categoryPath ?? '';
      const row = docs.findRow(documentId);
      if (row && toFolder && fromFolder !== toFolder) this.userRelocated({ documentId, fromFolder, toFolder, docType: row.docType, ext: row.ext });
    });
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

  /** After several similar relocations the agent proposes a rule – stored only after confirmation. */
  userRelocated({ documentId, fromFolder, toFolder, docType, ext }: UserRelocation): void {
    const key = `folder:${(docType ?? ext).toLowerCase()}→${toFolder.toLowerCase()}`;
    const count = this.deps.memory.recordCorrection({ did: `${docType ?? ext}-Datei nach ${fromFolder} abgelegt`, instead: `nach ${toFolder}`, key });
    if (count < CORRECTIONS_FOR_RULE) return;
    const name = `${docType ?? `.${ext}`} → ${toFolder}`;
    if (this.deps.memory.list('rule').some((r) => r.name === name)) return;
    const files = docType ?? `.${ext}-Dateien`;
    const rule = docType ? { when: { docType }, then: { folder: toFolder } } : { when: { ext }, then: { folder: toFolder } };
    this.deps.tools.insights.upsert({
      kind: 'learned_rule',
      title: `Soll ich ${files} künftig nach ${toFolder} legen?`,
      explanation: `Du hast ${count}× ${files}, die ich abgelegt hatte, nach ${toFolder} verschoben. Mit einer Regel lege ich solche Dateien künftig gleich dort ab. Gespeichert wird sie erst, wenn du zustimmst.`,
      confidence: 0.7,
      affected: [{ type: 'document', id: documentId, label: name }],
      action: {
        label: 'Regel speichern',
        proposal: {
          actionType: 'agent_batch',
          label: `Regel „${name}“ speichern`,
          rationale: 'Aus wiederholten Korrekturen gelernt.',
          confidence: 0.7,
          affectedEntities: [],
          requiredConfirmation: 'confirm',
          proposedParameters: {
            runId: newId(),
            items: [
              {
                tool: 'remember',
                args: { kind: 'rule', name, content: `${files} immer nach ${toFolder}`, rule },
                label: `Regel „${name}“ speichern`,
                risk: 'write',
                reason: '',
              },
            ],
            refs: { ids: {}, sets: {} },
          },
        },
      },
      dedupeKey: `learned-rule:${key}`,
    });
  }
}
