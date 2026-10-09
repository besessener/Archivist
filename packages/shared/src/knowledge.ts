import { z } from 'zod';
import { EntityRef, EntityType, Id, IsoDate, RelationMethod, RelationStatus, RelationType } from './common';

export const GraphEntity = z.object({
  id: Id,
  type: EntityType,
  name: z.string(),
  description: z.string().nullable(),
  /** Former names of entities merged into this one (resolve later mentions of these names). */
  aliases: z.array(z.string()),
  /** Roles of a person taken from mentions ("Chefin", "Führungskraft"); info only, not part of the name. */
  roles: z.array(z.string()),
  /** Discarded as a duplicate („verworfen (Duplikat)“, notes and events): the entity it was merged into. */
  duplicateOfId: z.string().nullable(),
  /** The user's own person (shown with the badge „Du“). */
  isSelf: z.boolean(),
  /** Lifecycle of a case („Vorgang“): open | closed. */
  status: z.string().nullish(),
  /** Topic/project taken from a document and not yet confirmed: never listed in LLM prompts (#199). */
  unconfirmed: z.boolean().optional(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type GraphEntity = z.infer<typeof GraphEntity>;

/** Named subjects the user can delete; records (decisions, notes …) have their own delete. */
export const DeletableSubjectType = z.enum(['person', 'topic', 'project', 'tag']);
export type DeletableSubjectType = z.infer<typeof DeletableSubjectType>;
export const isDeletableSubjectType = (type: string): type is DeletableSubjectType => DeletableSubjectType.safeParse(type).success;
export const GraphRelation = z.object({
  id: Id,
  sourceEntityId: Id,
  targetEntityId: Id,
  relationType: RelationType,
  confidence: z.number(),
  sourceIds: z.array(z.string()),
  status: RelationStatus,
  /** system = fixed methods, user, agent (#270); null for relations from before. */
  origin: z.string().nullish(),
  runId: z.string().nullish(),
  /** How the relation came about (#270); null if unknown (older relations). */
  method: RelationMethod.nullish(),
  /** Short, readable evidence – why it was proposed (#270). */
  evidence: z.string().nullish(),
  /** The user confirmed or rejected it explicitly (a confirmed field mirror without this flag was never decided by the user, #189). */
  resolvedByUser: z.boolean().optional(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type GraphRelation = z.infer<typeof GraphRelation>;

/** How a relation came about, in words (#270). */
export const RELATION_METHOD_LABELS: Record<RelationMethod, string> = {
  field: 'aus den Angaben des Eintrags',
  analysis: 'aus der Analyse',
  similarity: 'ähnlicher Inhalt',
  mention: 'im Text genannt',
  co_origin: 'gemeinsam entstanden',
  date_person: 'gleicher Tag, gleiche Person',
  wikilink: 'Wiki-Link',
  manual: 'von dir verknüpft',
  agent: 'vom Agenten vorgeschlagen',
  refinement: 'genauere Art (KI-Hinweis)',
};

/** The type of a relation in words (UI and server-written texts). */
export const RELATION_TYPE_LABELS: Record<RelationType, string> = {
  belongs_to: 'gehört zu',
  relates_to: 'hängt zusammen mit',
  supports: 'unterstützt',
  contradicts: 'widerspricht',
  participated_in: 'beteiligt an',
  responsible_for: 'verantwortlich für',
  concerns: 'betrifft',
  affects: 'wirkt auf',
  supersedes: 'ersetzt',
  blocks: 'blockiert',
  results_from: 'ergibt sich aus',
  produced: 'hat erzeugt',
  mentioned_in: 'erwähnt in',
  duplicate_of: 'Duplikat von',
  related_to: 'verwandt mit',
  subtopic_of: 'Unterthema von',
};

/** Who stands behind a relation (#270, #189); a field mirror counts as user-confirmed only if the user really confirmed it. */
export type RelationProvenance = 'manual' | 'user_confirmed' | 'user_rejected' | 'auto';
export function relationProvenance(r: Pick<GraphRelation, 'origin' | 'method' | 'resolvedByUser' | 'status'>): RelationProvenance {
  if (r.method === 'manual' || r.method === 'wikilink') return 'manual';
  if (r.resolvedByUser && r.status === 'confirmed') return 'user_confirmed';
  if (r.resolvedByUser && r.status === 'rejected') return 'user_rejected';
  return 'auto';
}
export const RELATION_PROVENANCE_LABELS: Record<RelationProvenance, string> = {
  manual: 'manuell',
  user_confirmed: 'von dir bestätigt',
  user_rejected: 'von dir abgelehnt',
  auto: 'automatisch',
};
export const EntityDetail = z.object({
  entity: GraphEntity,
  relations: z.array(
    GraphRelation.extend({
      direction: z.enum(['out', 'in']),
      other: GraphEntity,
    }),
  ),
});
export type EntityDetail = z.infer<typeof EntityDetail>;

export const KnowledgeCreateResult = z.object({ entity: GraphEntity, created: z.boolean() });
export type KnowledgeCreateResult = z.infer<typeof KnowledgeCreateResult>;

export const SearchResult = z.object({
  type: EntityType,
  id: Id,
  title: z.string(),
  snippet: z.string(),
  score: z.number(),
  path: z.string().nullable(),
  date: z.string().nullable(),
  matchedBy: z.array(z.enum(['keyword', 'semantic'])),
});
export type SearchResult = z.infer<typeof SearchResult>;

export const TimelineEntry = z.object({
  id: z.string(),
  date: z.string(),
  year: z.number(),
  kind: z.enum(['document', 'decision', 'open_item', 'event', 'contradiction', 'note']),
  title: z.string(),
  description: z.string().nullable(),
  refs: z.array(EntityRef),
  /** no known date (an undated decision without dated source document): `date` is only the capture day (#168) */
  undated: z.boolean().optional(),
});
export type TimelineEntry = z.infer<typeof TimelineEntry>;

export const TimelineQuery = z.object({
  topicId: z.string().optional(),
  projectId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  /** Maximum number of entries; the newest ones are returned (chronologically sorted). */
  limit: z.number().int().min(1).max(10000).default(300),
});
