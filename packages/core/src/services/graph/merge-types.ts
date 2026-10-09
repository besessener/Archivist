import type { EntityType } from '@archivist/shared';
import type { EntityRow, RelationRow } from './rows';

/** Audit undo type of merges and renames (one audit entry per call). */
export const MERGE_UNDO_TYPE = 'entity.merge';

export interface MergeRequest {
  /** Entities that are merged into the target and removed afterwards. */
  sourceIds: string[];
  targetId: string;
  /** Allows merging a topic into a project or vice versa; the target's type wins. */
  allowCrossType?: boolean;
  /** New name of the target (e.g. the cleanest spelling of a person); its former name becomes an alias. */
  targetName?: string;
  /** Roles added to the target in addition to those of the sources (e.g. parsed from „Monika Lor-Zade (Chefin)“). */
  addRoles?: string[];
}

export interface MergeOptions {
  actor?: 'user' | 'agent';
  trigger?: string;
  /** Audit action name (default `entity.merge`). */
  action?: string;
}

export interface MergeResult {
  targetId: string;
  targetName: string;
  targetType: EntityType;
  mergedIds: string[];
  mergedNames: string[];
  relationsMoved: number;
  /** Records (documents, decisions, open items, events) whose references or name lists were changed. */
  referencesUpdated: number;
}

export interface MergeBatchResult {
  /** The single audit entry; undoing it reverts all merges of the batch. */
  auditId: string;
  results: MergeResult[];
}

/** Records whose search index entry must be rebuilt after a merge or its undo. */
export interface MergeReindexRefs {
  documents: string[];
  decisions: string[];
  openItems: string[];
  events: string[];
}
export type MergeReindexer = (refs: MergeReindexRefs) => Promise<void>;

export type RefTableName = keyof MergeReindexRefs;
export type RefRow = Record<string, string | string[] | null>;
export type RefSets = Record<RefTableName, Set<string>>;
/** The values a change overwrote in one record, as its undo writes them back. */
export type RefBefore = { table: RefTableName; id: string; before: RefRow };

/** Exact prior state of one merge (undo data). */
export interface MergeStep {
  target: EntityRow;
  sources: EntityRow[];
  relationsDeleted: RelationRow[];
  relationsUpdated: RelationRow[];
  refs: RefBefore[];
}

export interface MergeUndoData {
  steps: MergeStep[];
  /** Fingerprints of every touched row right after the batch; any difference blocks the undo. */
  after: Record<string, string | null>;
}

/** What a merge batch collects: fingerprint keys of touched rows and records to reindex. */
export interface MergeLedger {
  touched: Set<string>;
  reindex: RefSets;
}

export const emptyRefSets = (): RefSets => ({ documents: new Set(), decisions: new Set(), openItems: new Set(), events: new Set() });

/** One step of a batch at time `now`, recording into `ledger`. */
export interface StepContext {
  step: MergeStep;
  now: string;
  ledger: MergeLedger;
}
