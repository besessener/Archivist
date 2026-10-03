import { z } from 'zod';
import { Confidence, Id, IsoDate, patchSchema } from './common';

/** What a document says about a decision: only `decided` (and `rejected`) are decisions; the rest was only talked about (#175). */
export const DecisionKind = z.enum(['decided', 'proposed', 'discussed', 'postponed', 'rejected']);
export type DecisionKind = z.infer<typeof DecisionKind>;
/** Where a decision was captured: dictated in the chat, entered in the form, or taken from a document. */
export const DecisionOrigin = z.enum(['chat', 'form', 'document']);
export type DecisionOrigin = z.infer<typeof DecisionOrigin>;

export const DecisionStatus = z.enum(['draft', 'confirmed', 'active', 'superseded', 'revoked', 'unclear']);
export type DecisionStatus = z.infer<typeof DecisionStatus>;
export const DecisionField = z.enum(['decidedAt', 'topic', 'participants', 'decisionText']);
export type DecisionField = z.infer<typeof DecisionField>;
export const DECISION_FIELD_LABELS: Record<DecisionField, string> = {
  decidedAt: 'Wann',
  topic: 'Thema',
  participants: 'Beteiligte',
  decisionText: 'Entscheidung',
};

export const Decision = z.object({
  id: Id,
  title: z.string(),
  decisionText: z.string(),
  decidedAt: IsoDate.nullable(),
  topicId: z.string().nullable(),
  topicName: z.string().nullable(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  participants: z.array(z.string()),
  rationale: z.string().nullable(),
  consequences: z.string().nullable(),
  alternatives: z.array(z.string()),
  status: DecisionStatus,
  validFrom: IsoDate.nullable(),
  validUntil: IsoDate.nullable(),
  supersedesDecisionId: z.string().nullable(),
  sourceIds: z.array(z.string()),
  confidence: z.number(),
  missingFields: z.array(DecisionField),
  unknownFields: z.array(DecisionField),
  /** null for decisions captured before the origin was recorded */
  origin: DecisionOrigin.nullable(),
  /** Verbatim sentence of the source document that states the decision (only for decisions from documents). */
  evidence: z.string().nullable(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type Decision = z.infer<typeof Decision>;

export const DecisionInput = z.object({
  title: z.string().optional(),
  decisionText: z.string().min(1),
  decidedAt: IsoDate.nullish(),
  topic: z.string().nullish(),
  project: z.string().nullish(),
  participants: z.array(z.string()).default([]),
  rationale: z.string().nullish(),
  consequences: z.string().nullish(),
  alternatives: z.array(z.string()).default([]),
  validFrom: IsoDate.nullish(),
  validUntil: IsoDate.nullish(),
  unknownFields: z.array(DecisionField).default([]),
  sourceIds: z.array(z.string()).default([]),
  confidence: Confidence.default(0.9),
  asDraft: z.boolean().default(false),
  origin: DecisionOrigin.optional(),
  evidence: z.string().nullish(),
});
export type DecisionInput = z.infer<typeof DecisionInput>;

/** Statuses an edit may set; superseding and revoking are level-2 actions with their own confirmed channels. */
export const EditableDecisionStatus = z.enum(['draft', 'confirmed', 'active', 'unclear']);
export type EditableDecisionStatus = z.infer<typeof EditableDecisionStatus>;
export const isEditableDecisionStatus = (s: DecisionStatus): s is EditableDecisionStatus => EditableDecisionStatus.safeParse(s).success;

/** Partial update of a decision: only the given fields change (no defaults, see `patchSchema`). */
export const DecisionPatch = patchSchema(DecisionInput.omit({ origin: true, evidence: true })).extend({ status: EditableDecisionStatus.optional() });
export type DecisionPatch = z.infer<typeof DecisionPatch>;
