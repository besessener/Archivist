import { z } from 'zod';
import { Confidence, EntityType, Id, IsoDate, patchSchema } from './common';

export const OpenItemStatus = z.enum(['open', 'waiting', 'blocked', 'resolved', 'dismissed']);
export type OpenItemStatus = z.infer<typeof OpenItemStatus>;
export const OPEN_ITEM_STATUS_LABELS: Record<OpenItemStatus, string> = {
  open: 'Offen',
  waiting: 'Wartet',
  blocked: 'Blockiert',
  resolved: 'Erledigt',
  dismissed: 'Verworfen',
};
export const Priority = z.enum(['low', 'normal', 'high']);

/** A claim of a solution proposal; `uncertain` if there is no valid source citation. */
const SolutionClaim = z.object({
  text: z.string(),
  detail: z.string().nullable().default(null),
  /** Source label like "S1" (see `sources`) */
  sourceRefs: z.array(z.string()).default([]),
  uncertain: z.boolean(),
});
/** Source that was (or would be) sent to the LLM for a solution proposal. */
export const SolutionSource = z.object({
  ref: z.string(),
  id: Id,
  type: EntityType,
  title: z.string(),
  /** false: only the title is sent (document excluded from the external analysis) */
  contentIncluded: z.boolean(),
  /** actually cited as evidence in the proposal */
  used: z.boolean().default(false),
});
export type SolutionSource = z.infer<typeof SolutionSource>;
/** Stored solution proposal for an open item (generating again replaces it). */
export const OpenItemSolution = z.object({
  generatedAt: IsoDate,
  model: z.string(),
  assessment: z.string(),
  assessmentSourceRefs: z.array(z.string()).default([]),
  assessmentUncertain: z.boolean(),
  nextSteps: z.array(SolutionClaim),
  openQuestions: z.array(z.string()),
  risks: z.array(SolutionClaim),
  uncertainties: z.array(z.string()),
  sources: z.array(SolutionSource),
  confidence: z.number(),
});
export type OpenItemSolution = z.infer<typeof OpenItemSolution>;

export const OpenItem = z.object({
  id: Id,
  title: z.string(),
  description: z.string().nullable(),
  topicId: z.string().nullable(),
  topicName: z.string().nullable(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  responsiblePersonId: z.string().nullable(),
  responsibleName: z.string().nullable(),
  responsibleUnknown: z.boolean(),
  createdAt: IsoDate,
  dueAt: IsoDate.nullable(),
  dueUnknown: z.boolean(),
  status: OpenItemStatus,
  priority: Priority,
  sourceIds: z.array(z.string()),
  /** Conversation the item comes from (if a source is a chat message). */
  sourceConversationId: z.string().nullable().default(null),
  reminderAt: IsoDate.nullable(),
  confidence: z.number(),
  updatedAt: IsoDate,
  /** Most recently generated solution proposal (with date and model) */
  solution: OpenItemSolution.nullable().default(null),
  /** Discarded as a duplicate („verworfen (Duplikat)“, status `dismissed`): the open item it was merged into. */
  duplicateOfId: z.string().nullable().default(null),
  /** Comment given when closing (how it was solved / why it was dropped); null while open. */
  resolutionNote: z.string().nullable().default(null),
});
export type OpenItem = z.infer<typeof OpenItem>;

/** What would be sent to the LLM for a solution proposal – determined without an LLM call. */
export const SolutionPreview = z.object({
  mode: z.enum(['auto', 'confirm', 'local_only']),
  /** false: generation currently not possible (see blockedReason) */
  available: z.boolean(),
  blockedReason: z.string().nullable(),
  /** Details of the item that are sent */
  itemFields: z.array(z.object({ label: z.string(), value: z.string() })),
  sources: z.array(SolutionSource),
});
export type SolutionPreview = z.infer<typeof SolutionPreview>;
export const OpenItemInput = z.object({
  title: z.string().min(1),
  description: z.string().nullish(),
  topic: z.string().nullish(),
  project: z.string().nullish(),
  responsible: z.string().nullish(),
  responsibleUnknown: z.boolean().optional(),
  dueAt: IsoDate.nullish(),
  dueUnknown: z.boolean().optional(),
  priority: Priority.default('normal'),
  sourceIds: z.array(z.string()).default([]),
  confidence: Confidence.default(0.9),
});
export type OpenItemInput = z.infer<typeof OpenItemInput>;

/** Statuses an edit (`openItems:update`) may set. „Erledigt“ and „Verworfen“ only via the confirmed `openItems:close` (with undo). */
export const EditableOpenItemStatus = z.enum(['open', 'waiting', 'blocked']);
export type EditableOpenItemStatus = z.infer<typeof EditableOpenItemStatus>;
export const isEditableOpenItemStatus = (s: OpenItemStatus): s is EditableOpenItemStatus => EditableOpenItemStatus.safeParse(s).success;

/** Partial update of an open item: only the given fields change (no defaults, see `patchSchema`). */
export const OpenItemPatch = patchSchema(OpenItemInput).extend({
  status: EditableOpenItemStatus.optional(),
});
export type OpenItemPatch = z.infer<typeof OpenItemPatch>;
