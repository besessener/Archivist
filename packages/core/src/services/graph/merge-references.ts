import type { EntityType } from '@archivist/shared';
import { eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { Db } from '../../db/database';
import { decisions, documents, events, openItems } from '../../db/schema';
import { normalizeName } from '../../util/text';
import type { RefRow, RefTableName, StepContext } from './merge-types';
import { replaceNames } from './names';
import { entityRow, relationRow, type EntityRow } from './rows';

type RefTableShape = typeof events;

interface RefTableSpec {
  table: typeof documents | typeof decisions | typeof openItems | typeof events;
  /** German labels for conflict messages: definite / indefinite article. */
  the: string;
  a: string;
  /** Columns that a merge may change (plus updatedAt); also the fingerprint used for conflict detection. */
  columns: string[];
  /** Name-list column per entity type (stores names, not ids). */
  lists: Partial<Record<EntityType, string>>;
  responsible?: boolean;
}

export const REF_TABLE_NAMES: RefTableName[] = ['documents', 'decisions', 'openItems', 'events'];
export const REF_TABLES: Record<RefTableName, RefTableSpec> = {
  documents: {
    table: documents,
    the: 'Das Dokument',
    a: 'Ein Dokument',
    columns: ['topicId', 'projectId', 'persons', 'tags', 'updatedAt'],
    lists: { person: 'persons', tag: 'tags' },
  },
  decisions: {
    table: decisions,
    the: 'Die Entscheidung',
    a: 'Eine Entscheidung',
    columns: ['topicId', 'projectId', 'participants', 'updatedAt'],
    lists: { person: 'participants' },
  },
  openItems: {
    table: openItems,
    the: 'Der offene Punkt',
    a: 'Ein offener Punkt',
    columns: ['topicId', 'projectId', 'responsiblePersonId', 'updatedAt'],
    lists: {},
    responsible: true,
  },
  events: {
    table: events,
    the: 'Das Ereignis',
    a: 'Ein Ereignis',
    columns: ['topicId', 'projectId', 'participants', 'updatedAt'],
    lists: { person: 'participants' },
  },
};

export const TOPIC_OR_PROJECT = new Set<string>(['topic', 'project']);

export const refTable = (name: RefTableName): RefTableShape => REF_TABLES[name].table as RefTableShape;
export const column = (table: RefTableShape, name: string): SQLiteColumn => (table as unknown as Record<string, SQLiteColumn>)[name]!;
export const selection = (table: RefTableShape, columns: string[]): Record<string, SQLiteColumn> =>
  Object.fromEntries(columns.map((name) => [name, column(table, name)]));

/** How the records of one merge step are rewritten. */
interface Rewrite {
  target: EntityRow;
  targetName: string;
  sourceIds: string[];
  sourceSet: Set<string>;
  sourceNames: Set<string>;
  touchesTopics: boolean;
}

/** What to rewrite in one table. */
interface TableRewrite {
  name: RefTableName;
  listColumn: string | undefined;
  responsible: boolean;
}

/** Clears topic/project slots that point to a merged entity and puts the target into the free slot of its type. */
function rehangSlots(row: RefRow, rewrite: Rewrite): void {
  let hit = false;
  for (const slot of ['topicId', 'projectId'] as const) {
    const value = row[slot];
    if (typeof value === 'string' && rewrite.sourceSet.has(value)) {
      row[slot] = null;
      hit = true;
    }
  }
  const slot = rewrite.target.type === 'topic' ? 'topicId' : 'projectId';
  if (hit && (row[slot] === null || row[slot] === rewrite.target.id)) row[slot] = rewrite.target.id;
}

function rewriteOf(change: StepContext, newName: string | undefined): Rewrite {
  const { target, sources } = change.step;
  const sourceIds = sources.map((source) => source.id);
  return {
    target,
    targetName: newName ?? target.name,
    sourceIds,
    sourceSet: new Set(sourceIds),
    sourceNames: new Set([...sources.flatMap((s) => [s.normalizedName, ...s.aliases.map(normalizeName)]), ...(newName ? [target.normalizedName] : [])]),
    touchesTopics: sources.some((source) => TOPIC_OR_PROJECT.has(source.type)),
  };
}

function conditionsOf(table: RefTableShape, plan: { rewrite: Rewrite; tableRewrite: TableRewrite }): SQL[] {
  const { rewrite, tableRewrite } = plan;
  const conditions: SQL[] = [];
  if (rewrite.touchesTopics) conditions.push(inArray(table.topicId, rewrite.sourceIds), inArray(table.projectId, rewrite.sourceIds));
  if (tableRewrite.responsible) conditions.push(inArray(column(table, 'responsiblePersonId'), rewrite.sourceIds));
  if (tableRewrite.listColumn) conditions.push(sql`${column(table, tableRewrite.listColumn)} != '[]'`);
  return conditions;
}

/** The row as the merge leaves it (pure). */
function rewrittenRow(row: RefRow, plan: { rewrite: Rewrite; tableRewrite: TableRewrite }): RefRow {
  const { rewrite, tableRewrite } = plan;
  const next: RefRow = { ...row };
  if (rewrite.touchesTopics) rehangSlots(next, rewrite);
  if (tableRewrite.responsible && rewrite.sourceSet.has(String(next.responsiblePersonId))) next.responsiblePersonId = rewrite.target.id;
  if (tableRewrite.listColumn)
    next[tableRewrite.listColumn] = replaceNames(next[tableRewrite.listColumn] as string[], { from: rewrite.sourceNames, to: rewrite.targetName });
  return next;
}

/** Re-hangs topic/project/responsible references and name lists in one table; returns the number of changed records. */
function rehangTable(db: Db, plan: { change: StepContext; rewrite: Rewrite; tableRewrite: TableRewrite }): number {
  const { change, tableRewrite } = plan;
  const spec = REF_TABLES[tableRewrite.name];
  const table = refTable(tableRewrite.name);
  const conditions = conditionsOf(table, plan);
  if (conditions.length === 0) return 0;
  const rows = db
    .select(selection(table, ['id', ...spec.columns]))
    .from(table)
    .where(or(...conditions))
    .all() as RefRow[];
  let updated = 0;
  for (const row of rows) {
    const next = rewrittenRow(row, plan);
    const changed = spec.columns.filter((name) => name !== 'updatedAt' && JSON.stringify(next[name]) !== JSON.stringify(row[name]));
    if (changed.length === 0) continue;
    const id = String(row.id);
    const before: RefRow = { updatedAt: row.updatedAt ?? null };
    const set: RefRow = { updatedAt: change.now };
    for (const name of changed) {
      before[name] = row[name] ?? null;
      set[name] = next[name] ?? null;
    }
    db.update(table).set(set).where(eq(table.id, id)).run();
    change.step.refs.push({ table: tableRewrite.name, id, before });
    change.ledger.touched.add(`${tableRewrite.name}:${id}`);
    change.ledger.reindex[tableRewrite.name].add(id);
    updated += 1;
  }
  return updated;
}

/** Re-hangs references in documents, decisions, open items and events; `newName` also renames the target in name lists. */
export function rehangReferences(db: Db, request: { change: StepContext; newName?: string }): number {
  const { change } = request;
  const rewrite = rewriteOf(change, request.newName);
  const targetType = rewrite.target.type as EntityType;
  let updated = 0;
  for (const name of REF_TABLE_NAMES) {
    const spec = REF_TABLES[name];
    const responsible = spec.responsible === true && targetType === 'person' && rewrite.sourceIds.length > 0;
    updated += rehangTable(db, { change, rewrite, tableRewrite: { name, listColumn: spec.lists[targetType], responsible } });
  }
  return updated;
}

export const splitKey = (key: string): { kind: string; id: string } => {
  const separator = key.indexOf(':');
  return { kind: key.slice(0, separator), id: key.slice(separator + 1) };
};

/** Serialized current state of a row named by a fingerprint key (`entity:<id>`, `relation:<id>`, `<refTable>:<id>`). */
export function fingerprint(db: Db, key: string): string | null {
  const { kind, id } = splitKey(key);
  if (kind === 'entity') {
    const row = entityRow(db, id);
    return row ? JSON.stringify(row) : null;
  }
  if (kind === 'relation') {
    const row = relationRow(db, id);
    return row ? JSON.stringify(row) : null;
  }
  const table = refTable(kind as RefTableName);
  const row = db
    .select(selection(table, REF_TABLES[kind as RefTableName].columns))
    .from(table)
    .where(eq(table.id, id))
    .get();
  return row ? JSON.stringify(row) : null;
}

export function fingerprints(db: Db, keys: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const key of keys) out[key] = fingerprint(db, key);
  return out;
}
