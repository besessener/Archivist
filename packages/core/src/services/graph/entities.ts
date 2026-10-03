import type { EntityType, GraphEntity } from '@archivist/shared';
import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { entities, relations } from '../../db/schema';
import { AppError } from '../../util/errors';
import { newId, nowIso } from '../../util/ids';
import { normalizeName } from '../../util/text';
import { collapseWhitespace, mergeAliases, mergeRoles } from './names';
import { entityRow, mapEntity, otherEndOf, relationRowsOf, type EntityRow, type RelationRow } from './rows';

/** A node with its relations, captured before a removal so an undo can restore both. */
export interface NodeSnapshot {
  node: EntityRow;
  relations: RelationRow[];
}

export interface EntityQuery {
  type?: EntityType;
  query?: string;
  limit?: number;
  /** Without topics/projects taken from documents that the user has not confirmed (for LLM prompts). */
  confirmedOnly?: boolean;
}

export interface NewEntity {
  type: EntityType;
  name: string;
  description?: string | null;
  /** The name was taken from a document's analysis: a new topic/project stays unconfirmed (#199). */
  fromDocument?: boolean;
}

/** Entity nodes of the knowledge graph: named nodes (topics, persons …) and the nodes of records. */
export class GraphEntities {
  constructor(private readonly ctx: AppContext) {}

  private get db() {
    return this.ctx.database.db;
  }

  get(id: string): GraphEntity | undefined {
    const row = entityRow(this.db, id);
    return row ? mapEntity(row) : undefined;
  }

  byIds(ids: string[]): GraphEntity[] {
    if (ids.length === 0) return [];
    return this.db.select().from(entities).where(inArray(entities.id, ids)).all().map(mapEntity);
  }

  /** The entity of this type with this name or unique alias, created if missing; any use not taken from a document confirms it. */
  ensure(request: NewEntity): GraphEntity {
    const clean = collapseWhitespace(request.name);
    if (!clean) throw new AppError('validation_error', 'Der Name darf nicht leer sein.');
    const normalizedName = normalizeName(clean);
    const existing = this.rowByNameOrAlias(request.type, clean);
    if (existing) return existing.unconfirmed && !request.fromDocument ? this.confirm(existing.id) : mapEntity(existing);
    const now = nowIso();
    const row: EntityRow = {
      id: newId(),
      type: request.type,
      name: clean,
      normalizedName,
      description: request.description ?? null,
      aliases: [],
      roles: [],
      duplicateOfId: null,
      isSelf: false,
      unconfirmed: Boolean(request.fromDocument) && (request.type === 'topic' || request.type === 'project'),
      createdAt: now,
      updatedAt: now,
      status: request.type === 'case' ? 'open' : null,
    };
    this.db.insert(entities).values(row).run();
    this.ctx.events.changed('knowledge');
    return mapEntity(row);
  }

  confirm(id: string): GraphEntity {
    const row = this.requireRow(id);
    if (!row.unconfirmed) return mapEntity(row);
    const updatedAt = nowIso();
    this.db.update(entities).set({ unconfirmed: false, updatedAt }).where(eq(entities.id, id)).run();
    this.ctx.events.changed('knowledge');
    return mapEntity({ ...row, unconfirmed: false, updatedAt });
  }

  findByName(type: EntityType, name: string): GraphEntity | undefined {
    const row = this.rowByName(type, name);
    return row ? mapEntity(row) : undefined;
  }

  /** Exact name first, otherwise a unique alias; an alias of several entities of the type is ambiguous. */
  findByNameOrAlias(type: EntityType, name: string): GraphEntity | undefined {
    const row = this.rowByNameOrAlias(type, name);
    return row ? mapEntity(row) : undefined;
  }

  private rowByName(type: EntityType, name: string): EntityRow | undefined {
    return this.db
      .select()
      .from(entities)
      .where(and(eq(entities.type, type), eq(entities.normalizedName, normalizeName(name))))
      .get();
  }

  private rowByNameOrAlias(type: EntityType, name: string): EntityRow | undefined {
    const exact = this.rowByName(type, name);
    if (exact) return exact;
    const normalized = normalizeName(name);
    if (!normalized) return undefined;
    const hits = this.db
      .select()
      .from(entities)
      .where(and(eq(entities.type, type), sql`${entities.aliases} != '[]'`))
      .all()
      .filter((row) => row.aliases.some((alias) => normalizeName(alias) === normalized));
    return hits.length === 1 ? hits[0] : undefined;
  }

  register(node: { type: EntityType; id: string; name: string; description?: string | null }): void {
    const now = nowIso();
    const normalizedName = normalizeName(node.name);
    const description = node.description ?? null;
    this.db
      .insert(entities)
      .values({ id: node.id, type: node.type, name: node.name, normalizedName, description, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: entities.id, set: { name: node.name, normalizedName, description, updatedAt: now } })
      .run();
  }

  remove(id: string): void {
    this.db
      .delete(relations)
      .where(or(eq(relations.sourceEntityId, id), eq(relations.targetEntityId, id)))
      .run();
    this.db.delete(entities).where(eq(entities.id, id)).run();
    this.ctx.events.changed('knowledge');
  }

  snapshot(id: string): NodeSnapshot | null {
    const node = entityRow(this.db, id);
    return node ? { node, relations: relationRowsOf(this.db, id) } : null;
  }

  /** Restores a snapshot with its original ids; returns the number of relations skipped because their other end is gone. */
  restore(snapshot: NodeSnapshot): number {
    this.db.insert(entities).values(snapshot.node).onConflictDoNothing().run();
    let skipped = 0;
    for (const relation of snapshot.relations) {
      if (!entityRow(this.db, otherEndOf(relation, snapshot.node.id))) {
        skipped++;
        continue;
      }
      this.db.insert(relations).values(relation).onConflictDoNothing().run();
    }
    this.ctx.events.changed('knowledge');
    return skipped;
  }

  list(query: EntityQuery): Array<GraphEntity & { relationCount: number }> {
    const conditions = [];
    if (query.type) conditions.push(eq(entities.type, query.type));
    if (query.confirmedOnly) conditions.push(eq(entities.unconfirmed, false));
    if (query.query?.trim()) conditions.push(like(entities.normalizedName, `%${normalizeName(query.query)}%`));
    const rows = this.db
      .select()
      .from(entities)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(entities.name)
      .limit(query.limit ?? 300)
      .all();
    if (rows.length === 0) return [];
    const counts = this.currentRelationCounts(rows.map((row) => row.id));
    return rows.map((row) => ({ ...mapEntity(row), relationCount: counts.get(row.id) ?? 0 }));
  }

  private currentRelationCounts(ids: string[]): Map<string, number> {
    const counts = new Map<string, number>();
    const current = this.db
      .select({ source: relations.sourceEntityId, target: relations.targetEntityId })
      .from(relations)
      .where(and(or(inArray(relations.sourceEntityId, ids), inArray(relations.targetEntityId, ids)), sql`${relations.status} NOT IN ('rejected', 'outdated')`))
      .all();
    for (const relation of current) {
      counts.set(relation.source, (counts.get(relation.source) ?? 0) + 1);
      counts.set(relation.target, (counts.get(relation.target) ?? 0) + 1);
    }
    return counts;
  }

  addAlias(entityId: string, alias: string): GraphEntity {
    const row = this.requireRow(entityId);
    const aliases = mergeAliases(row, [alias]);
    if (aliases.length === row.aliases.length) return mapEntity(row);
    return this.update(row, { aliases });
  }

  /** Forgets one alias again (case-insensitive); the entity stays unchanged when it has no such alias. */
  removeAlias(entityId: string, alias: string): GraphEntity {
    const row = this.requireRow(entityId);
    const aliases = row.aliases.filter((existing) => normalizeName(existing) !== normalizeName(alias));
    if (aliases.length === row.aliases.length) return mapEntity(row);
    return this.update(row, { aliases });
  }

  addRoles(entityId: string, roles: string[]): GraphEntity {
    const row = this.requireRow(entityId);
    const merged = mergeRoles(row.roles, roles);
    if (merged.length === row.roles.length) return mapEntity(row);
    return this.update(row, { roles: merged });
  }

  private update(row: EntityRow, change: Partial<Pick<EntityRow, 'aliases' | 'roles'>>): GraphEntity {
    const updatedAt = nowIso();
    this.db
      .update(entities)
      .set({ ...change, updatedAt })
      .where(eq(entities.id, row.id))
      .run();
    this.ctx.events.changed('knowledge');
    return mapEntity({ ...row, ...change, updatedAt });
  }

  private requireRow(id: string): EntityRow {
    const row = entityRow(this.db, id);
    if (!row) throw new AppError('validation_error', 'Eintrag nicht gefunden.');
    return row;
  }
}
