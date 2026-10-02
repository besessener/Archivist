import type { z } from 'zod';
import type { ActionParamSchemas, Contradiction } from '@archivist/shared';
import type { ArchiveService } from './archive';
import type { AuditService } from './audit';
import type { DecisionService } from './decisions';
import type { DocumentService } from './documents';
import type { KnowledgeGraphService } from './knowledge-graph';
import type { OpenItemService } from './open-items';
import type { ReminderService } from './reminders';
import type { UndoService } from './undo';

/** Executes a confirmed proposal card of an agent run (provided by the agent service, #298). */
export type AgentBatchExecutor = (params: z.output<(typeof ActionParamSchemas)['agent_batch']>) => Promise<string>;

type MergeOptions = { actor?: 'user' | 'agent'; trigger?: string };

// Narrow views of services whose modules import the action service: naming their classes would close an import cycle.

interface ContradictionResolver {
  get(id: string): Pick<Contradiction, 'status'>;
  resolve(
    id: string,
    resolution: 'acknowledged' | 'resolved' | 'false_positive',
    opts: { confirmed: boolean; supersedeOldDecisionId?: string; supersedeNewDecisionId?: string },
  ): unknown;
  settlePair(oldId: string, newId: string): void;
}

interface NoteEventMerger {
  staleReason(kind: 'note' | 'event', keepId: string, duplicateId: string): string | null;
  mergeNotes(keepId: string, duplicateId: string, opts?: MergeOptions): { keepTitle: string; duplicateTitle: string; takenOver: string[] };
  mergeEvents(keepId: string, duplicateId: string, opts?: MergeOptions): { keepTitle: string; duplicateTitle: string; takenOver: string[] };
}

interface OpenItemMerger {
  staleReason(keepId: string, duplicateId: string): string | null;
  merge(keepId: string, duplicateId: string, opts?: MergeOptions): { keep: { title: string }; duplicate: { title: string }; takenOver: string[] };
}

interface PathExcluder {
  exclude(kind: 'file' | 'dir', path: string): unknown;
}

export interface ActionDeps {
  archive: ArchiveService;
  documents: DocumentService;
  decisions: DecisionService;
  openItems: OpenItemService;
  openItemDuplicates: OpenItemMerger;
  contradictions: ContradictionResolver;
  graph: KnowledgeGraphService;
  noteEventDuplicates: NoteEventMerger;
  scanner: PathExcluder;
  reminders: ReminderService;
  audit: AuditService;
  undo: UndoService;
  agentBatch?: AgentBatchExecutor;
}
