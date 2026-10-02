import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../../context';
import type { Db } from '../../db/database';
import { entities, relations } from '../../db/schema';
import { REF_TABLES, fingerprint, refTable, splitKey } from './merge-references';
import { emptyRefSets, type MergeStep, type MergeUndoData, type RefSets, type RefTableName } from './merge-types';
import { entityRow } from './rows';

function entityConflict(db: Db, conflict: { id: string; expected: string | null; steps: MergeStep[] }): string {
  const known = conflict.steps.flatMap((step) => [step.target, ...step.sources]).find((entity) => entity.id === conflict.id);
  const label = known ? `„${known.name}“` : 'Ein Eintrag';
  if (conflict.expected === null) return `${label} wurde seit der Zusammenführung wieder angelegt.`;
  if (!entityRow(db, conflict.id)) return `${label} wurde seit der Zusammenführung gelöscht.`;
  return `${label} wurde seit der Zusammenführung verändert.`;
}

function recordConflict(db: Db, record: { name: RefTableName; id: string }): string {
  const spec = REF_TABLES[record.name];
  const table = refTable(record.name);
  const row = db.select({ title: table.title }).from(table).where(eq(table.id, record.id)).get();
  return row ? `${spec.the} „${row.title}“ wurde seit der Zusammenführung verändert.` : `${spec.a} wurde seit der Zusammenführung gelöscht.`;
}

/** A merged name was created again in the meantime (restoring it would produce a duplicate). */
function recreatedNames(db: Db, steps: MergeStep[]): string[] {
  const restoring = new Set(steps.flatMap((step) => [step.target.id, ...step.sources.map((source) => source.id)]));
  return steps.flatMap((step) =>
    step.sources.flatMap((source) => {
      const duplicate = db
        .select()
        .from(entities)
        .where(and(eq(entities.type, source.type), eq(entities.normalizedName, source.normalizedName)))
        .all()
        .find((entity) => !restoring.has(entity.id));
      return duplicate ? [`„${duplicate.name}“ wurde seit der Zusammenführung neu angelegt. Bitte zuerst diesen Eintrag bereinigen.`] : [];
    }),
  );
}

/** Conflicts (German) that block undoing a merge: rows changed since, or merged names created again. */
export function mergeConflicts(db: Db, data: MergeUndoData): string[] {
  const out = new Set<string>();
  for (const [key, expected] of Object.entries(data.after)) {
    if (fingerprint(db, key) === expected) continue;
    const { kind, id } = splitKey(key);
    if (kind === 'entity') out.add(entityConflict(db, { id, expected, steps: data.steps }));
    else if (kind === 'relation') out.add('Eine betroffene Beziehung wurde seit der Zusammenführung verändert oder gelöscht.');
    else out.add(recordConflict(db, { name: kind as RefTableName, id }));
  }
  for (const message of recreatedNames(db, data.steps)) out.add(message);
  return [...out];
}

function restoreStep(db: Db, request: { step: MergeStep; reindex: RefSets }): void {
  const { step, reindex } = request;
  if (step.sources.length) db.insert(entities).values(step.sources).run();
  const { id: targetId, ...target } = step.target;
  db.update(entities).set(target).where(eq(entities.id, targetId)).run();
  for (const { id, ...rest } of step.relationsUpdated) db.update(relations).set(rest).where(eq(relations.id, id)).run();
  if (step.relationsDeleted.length) db.insert(relations).values(step.relationsDeleted).run();
  for (const ref of step.refs) {
    const table = refTable(ref.table);
    db.update(table).set(ref.before).where(eq(table.id, ref.id)).run();
    reindex[ref.table].add(ref.id);
  }
}

/** Restores the state before the merges (newest step first); returns the records to reindex. */
export function restoreMerges(ctx: AppContext, data: MergeUndoData): RefSets {
  const reindex = emptyRefSets();
  ctx.database.transaction(() => {
    for (const step of [...data.steps].reverse()) restoreStep(ctx.database.db, { step, reindex });
  });
  return reindex;
}

export function mergeUndoneMessage(data: MergeUndoData): string {
  const names = data.steps.flatMap((step) => step.sources.map((source) => `„${source.name}“`));
  if (names.length === 0) return `Umbenennung rückgängig gemacht: „${data.steps[0]?.target.name ?? ''}“ wiederhergestellt.`;
  return `Zusammenführung rückgängig gemacht: ${names.join(', ')} wiederhergestellt.`;
}
