import type { AuditVerification } from '@archivist/shared';
import { sha256Text } from '../util/hash';

/** The fields of an audit entry that never change after writing; outcome fields (`after`, `error`, undo data, `undoneAt`) are amended later and not chained. */
export interface ChainedFields {
  id: string;
  at: string;
  action: string;
  actor: string;
  trigger: string;
  confirmed: boolean;
  entityIds: string[];
  paths: string[];
  before: unknown;
  success: boolean;
  runId: string | null;
}

export interface ChainedRow extends ChainedFields {
  hash: string | null;
  prevHash: string | null;
}

/** Hash of an entry over its fixed fields and the hash of the entry before it. */
export function chainHash(fields: ChainedFields, prevHash: string | null): string {
  const { id, at, action, actor, trigger, confirmed, entityIds, paths, before, success, runId } = fields;
  return sha256Text(JSON.stringify([prevHash, id, at, action, actor, trigger, confirmed, entityIds, paths, before ?? null, success, runId]));
}

/** Walks the rows in write order: an entry changed, removed or inserted after the first chained one breaks the chain at the entry that no longer fits. */
export function verifyChain(rows: ChainedRow[]): AuditVerification {
  let expectedPrev: string | null = null;
  let started = false;
  let checked = 0;
  for (const row of rows) {
    if (!started && row.hash === null) continue;
    started = true;
    checked += 1;
    const intact = row.hash !== null && row.prevHash === expectedPrev && row.hash === chainHash(row, expectedPrev);
    if (!intact) return { checked, brokenEntryId: row.id };
    expectedPrev = row.hash;
  }
  return { checked, brokenEntryId: null };
}
