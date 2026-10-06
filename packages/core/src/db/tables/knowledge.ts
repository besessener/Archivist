import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { jsonArr } from './columns';

/** Generic node table of the knowledge graph. Documents, decisions and open items share their id with their node. */
export const entities = sqliteTable(
  'entities',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    description: text('description'),
    /** Former names of entities merged into this one (display form); used to resolve later mentions. */
    aliases: jsonArr('aliases'),
    /** Roles of a person found in mentions ("Chefin", "Führungskraft"); stored as info, never part of the name. */
    roles: jsonArr('roles'),
    /** Set when the node was discarded as a duplicate („verworfen (Duplikat)“, notes and events): the entity it was merged into. */
    duplicateOfId: text('duplicate_of_id'),
    /** The user's own person („Du“); at most one entity carries the flag. */
    isSelf: integer('is_self', { mode: 'boolean' }).notNull().default(false),
    /** Lifecycle of a case („Vorgang“, #286): open | closed; null for all other entity types. */
    status: text('status'),
    /** Topic/project taken from a document and not yet confirmed by the user: kept out of LLM prompts (#199). */
    unconfirmed: integer('unconfirmed', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('entities_type_name_idx').on(t.type, t.normalizedName)],
);

export const relations = sqliteTable(
  'relations',
  {
    id: text('id').primaryKey(),
    sourceEntityId: text('source_entity_id').notNull(),
    targetEntityId: text('target_entity_id').notNull(),
    relationType: text('relation_type').notNull(),
    confidence: real('confidence').notNull().default(0.5),
    sourceIds: jsonArr('source_ids'),
    status: text('status').notNull().default('proposed'),
    /** Set once the user explicitly confirmed or rejected the relation; such relations are never changed by field sync. */
    resolvedByUser: integer('resolved_by_user', { mode: 'boolean' }).notNull().default(false),
    /** Who created the relation: system (fixed methods), user, agent (#270); null for relations from before #270. */
    origin: text('origin'),
    /** Agent run that created the relation (#299). */
    runId: text('run_id'),
    /** How the relation came about: field, analysis, similarity, mention, co_origin, date_person, manual, agent … (#270); null if unknown. */
    method: text('method'),
    /** Short, readable evidence: the passage, the message or the reason it was proposed for (#270). */
    evidence: text('evidence'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('relations_unique_idx').on(t.sourceEntityId, t.targetEntityId, t.relationType), index('relations_target_idx').on(t.targetEntityId)],
);

/** Names the user deleted: the automatic analysis does not create them again (type + normalized name). */
export const blockedSubjects = sqliteTable(
  'blocked_subjects',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    normalizedName: text('normalized_name').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('blocked_subjects_unique_idx').on(t.type, t.normalizedName)],
);
