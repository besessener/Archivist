import { z } from 'zod';

/** ISO 8601 date (YYYY-MM-DD) or timestamp. */
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, 'Erwartet ISO-Datum (YYYY-MM-DD)');
export const Confidence = z.number().min(0).max(1);
export const Id = z.string().min(1).max(100);

type WithoutDefault<T> = T extends z.ZodDefault<infer Inner> ? Inner : T;
type WithoutDefaults<Shape extends z.ZodRawShape> = { [K in keyof Shape]: WithoutDefault<Shape[K]> };

/**
 * Patch schema for an object schema: every field optional and WITHOUT `.default()`.
 * Zod 4 applies defaults even inside `.partial()` / `.optional()`, so `Schema.partial()` would fill in every
 * missing field and a partial update would overwrite the stored values with defaults (issues #55, #58).
 * Only top-level defaults are removed; nested objects keep theirs.
 */
export function patchSchema<Shape extends z.ZodRawShape>(schema: z.ZodObject<Shape>) {
  const shape = Object.fromEntries(
    Object.entries(schema.shape).map(([key, field]) => [key, field instanceof z.ZodDefault ? field.unwrap() : field]),
  ) as WithoutDefaults<Shape>;
  return z.object(shape).partial();
}

export const EntityType = z.enum(['document', 'decision', 'topic', 'project', 'person', 'event', 'question', 'task', 'note', 'category', 'tag', 'case']);
export type EntityType = z.infer<typeof EntityType>;

export const RelationType = z.enum([
  'belongs_to',
  'relates_to',
  'supports',
  'contradicts',
  'participated_in',
  'responsible_for',
  'concerns',
  'affects',
  'supersedes',
  'blocks',
  'results_from',
  'produced',
  'duplicate_of',
  'related_to',
]);
export type RelationType = z.infer<typeof RelationType>;

/**
 * How a relation came about (#270): `field` mirrors a field of the entry (topic, project, persons, tags, folder),
 * `analysis` comes from analysing a document or note, `similarity` from similar content, `mention` from a named topic or
 * project, `co_origin` from the same chat message or document, `date_person` from the same day with the same person,
 * `wikilink` from a `[[Name]]` link, `manual` from the user, `agent` from the agent's own proposal.
 */
export const RelationMethod = z.enum(['field', 'analysis', 'similarity', 'mention', 'co_origin', 'date_person', 'wikilink', 'manual', 'agent']);
export type RelationMethod = z.infer<typeof RelationMethod>;

export const RelationStatus = z.enum(['proposed', 'confirmed', 'rejected', 'outdated']);
export type RelationStatus = z.infer<typeof RelationStatus>;

export const ErrorCategory = z.enum([
  'validation_error',
  'database_error',
  'filesystem_error',
  'parser_error',
  'llm_error',
  'network_error',
  'permission_error',
  'scan_error',
  'archive_conflict',
  'native_module_error',
]);
export type ErrorCategory = z.infer<typeof ErrorCategory>;

export const AppErrorInfo = z.object({
  category: ErrorCategory,
  message: z.string(),
  retryable: z.boolean(),
  details: z.string().optional(),
});
export type AppErrorInfo = z.infer<typeof AppErrorInfo>;

/** Response envelope of every IPC channel. */
export const resultSchema = <T extends z.ZodType>(data: T) =>
  z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data }), z.object({ ok: z.literal(false), error: AppErrorInfo })]);
export type Result<T> = { ok: true; data: T } | { ok: false; error: AppErrorInfo };

/**
 * Kind of a reference (context panel, sources, chips): all knowledge objects plus reminders and contradictions,
 * which are no graph entities but still link to their own view.
 */
export const RefType = z.enum([...EntityType.options, 'reminder', 'contradiction']);
export type RefType = z.infer<typeof RefType>;

/** Reference to a knowledge object for the context panel, sources and actions. */
export const EntityRef = z.object({
  type: RefType,
  id: Id,
  label: z.string(),
  detail: z.string().nullish(),
});
export type EntityRef = z.infer<typeof EntityRef>;

export const SourceReference = z.object({
  id: Id,
  type: RefType,
  title: z.string(),
  snippet: z.string().default(''),
  path: z.string().nullish(),
  date: z.string().nullish(),
  /** What `date` is: the document's own date, its archive date, the decision date, … – shown as a label (#168). */
  dateKind: z.enum(['document', 'archived', 'decided', 'occurred', 'created']).nullish(),
  score: z.number().default(0),
});
export type SourceReference = z.infer<typeof SourceReference>;
