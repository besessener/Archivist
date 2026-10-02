import { z } from 'zod';
import { EntityType, IsoDate, RelationMethod, RelationStatus, RelationType } from './common';
import { GraphRelation } from './knowledge';

/** A related entry – direct or over shared topics, projects, persons, tags, cases – with strength and reason (#276). */
const RelatedItem = z.object({
  entity: z.object({ id: z.string(), type: EntityType, name: z.string(), description: z.string().nullable() }),
  score: z.number(),
  reason: z.string(),
  relation: GraphRelation.nullable(),
  shared: z.array(z.object({ id: z.string(), type: EntityType, name: z.string() })),
});
export const RelatedPage = z.object({ total: z.number().int(), items: z.array(RelatedItem) });
export type RelatedPage = z.infer<typeof RelatedPage>;

/** An open link proposal with both ends, for the review list (#280). */
const LinkProposalEnd = z.object({ id: z.string(), type: EntityType, name: z.string() });
export const LinkProposalPage = z.object({
  total: z.number().int(),
  groups: z.array(z.object({ key: z.string(), label: z.string(), count: z.number().int() })),
  items: z.array(z.object({ relation: GraphRelation, source: LinkProposalEnd, target: LinkProposalEnd, groupKey: z.string() })),
});
export type LinkProposalPage = z.infer<typeof LinkProposalPage>;
export const LinkGroupBy = z.enum(['method', 'entry']);

const SubjectRef = z.object({ id: z.string(), name: z.string() });
/** Main and further topics/projects of an entry (#287). */
export const EntrySubjects = z.object({
  topic: SubjectRef.nullable(),
  project: SubjectRef.nullable(),
  extraTopics: z.array(SubjectRef),
  extraProjects: z.array(SubjectRef),
});
export type EntrySubjects = z.infer<typeof EntrySubjects>;

/** The surroundings of an entry for the graph view (#288). */
export const NeighborhoodGraph = z.object({
  centerId: z.string(),
  nodes: z.array(
    z.object({
      id: z.string(),
      type: EntityType,
      name: z.string(),
      depth: z.number().int(),
      count: z.number().int().nullable(),
      status: z.string().nullable(),
    }),
  ),
  edges: z.array(
    z.object({ id: z.string(), source: z.string(), target: z.string(), relationType: RelationType, status: RelationStatus, grouped: z.boolean().optional() }),
  ),
  truncated: z.boolean(),
});
export type NeighborhoodGraph = z.infer<typeof NeighborhoodGraph>;

/** A case („Vorgang“) with its numbers (#286). */
export const CaseSummary = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.enum(['open', 'closed']),
  entries: z.number().int(),
  openItems: z.number().int(),
  updatedAt: IsoDate,
});
/** An entry of a case, with its date for the timeline (#286). */
export const CaseEntry = z.object({
  id: z.string(),
  type: EntityType,
  name: z.string(),
  date: z.string().nullable(),
  status: z.string().nullable(),
  proposed: z.boolean(),
  relationId: z.string(),
});

/** A threshold learned from the user's rejections (#275). */
export const LearnedThreshold = z.object({
  method: RelationMethod,
  label: z.string(),
  measure: z.string(),
  offset: z.number(),
  cap: z.number(),
  confirmed: z.number().int(),
  rejected: z.number().int(),
});

/** How well the archive is linked (#292): current values, confirmation rate per method and the history. */
const LinkageSnapshot = z.object({
  at: IsoDate,
  entries: z.number().int(),
  orphans: z.number().int(),
  openProposals: z.number().int(),
  confirmationRate: z.number().nullable(),
});
export const LinkageMetrics = z.object({
  current: LinkageSnapshot,
  methods: z.array(
    z.object({
      method: RelationMethod,
      label: z.string(),
      confirmed: z.number().int(),
      rejected: z.number().int(),
      open: z.number().int(),
      rate: z.number().nullable(),
    }),
  ),
  history: z.array(LinkageSnapshot),
});
export type LinkageMetrics = z.infer<typeof LinkageMetrics>;

/** A link candidate of the fixed link methods with its reason (#271, #283, #313). */
export const LinkCandidate = z.object({
  id: z.string(),
  type: EntityType,
  name: z.string(),
  score: z.number(),
  method: z.enum(['similarity', 'mention']),
  reason: z.string(),
});
export type LinkCandidate = z.infer<typeof LinkCandidate>;
