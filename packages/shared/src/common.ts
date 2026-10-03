import { z } from 'zod';

/** ISO 8601 date (YYYY-MM-DD) or timestamp. */
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, 'Erwartet ISO-Datum (YYYY-MM-DD)');
export const Confidence = z.number().min(0).max(1);
export const Id = z.string().min(1).max(100);

type WithoutDefault<T> = T extends z.ZodDefault<infer Inner> ? Inner : T;
type WithoutDefaults<Shape extends z.ZodRawShape> = { [K in keyof Shape]: WithoutDefault<Shape[K]> };

/** All top-level fields optional and without `.default()`: Zod 4 fills defaults even in `.partial()`, which would overwrite stored values (#55, #58). */
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
  /** A person named in a document's text: person → document (#189). */
  'mentioned_in',
  'duplicate_of',
  'related_to',
  /** A topic or project below another one: „Urlaub 2026“ is a subtopic of „Urlaub“ (#282). */
  'subtopic_of',
]);
export type RelationType = z.infer<typeof RelationType>;

/** How a relation came about (#270, #284); readable labels in `RELATION_METHOD_LABELS`. */
export const RelationMethod = z.enum(['field', 'analysis', 'similarity', 'mention', 'co_origin', 'date_person', 'wikilink', 'manual', 'agent', 'refinement']);
export type RelationMethod = z.infer<typeof RelationMethod>;

export const RelationStatus = z.enum(['proposed', 'confirmed', 'rejected', 'outdated']);
export type RelationStatus = z.infer<typeof RelationStatus>;

export const ErrorCategory = z.enum([
  'validation_error',
  'database_error',
  'database_corrupt',
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

/** Kind of a reference: every graph entity type plus reminders and contradictions, which link to their own view. */
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
  /** The source came in over a confirmed relation of another hit, e.g. „„Angebot“ stützt diesen Eintrag“ (#289). */
  via: z.string().nullish(),
  /** Status of a decision source („Widerrufen“, „Unklar“ …), so a source that is not valid is recognisable without the LLM. */
  statusNote: z.string().nullish(),
});
export type SourceReference = z.infer<typeof SourceReference>;
