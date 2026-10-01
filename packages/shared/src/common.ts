import { z } from 'zod';

/** ISO-8601 Datum (YYYY-MM-DD) oder Zeitstempel. */
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, 'Erwartet ISO-Datum (YYYY-MM-DD)');
export const Confidence = z.number().min(0).max(1);
export const Id = z.string().min(1).max(100);

export const EntityType = z.enum(['document', 'decision', 'topic', 'project', 'person', 'event', 'question', 'task', 'note', 'category', 'tag']);
export type EntityType = z.infer<typeof EntityType>;

export const RelationType = z.enum([
  'belongs_to',
  'relates_to',
  'supports',
  'contradicts',
  'participated_in',
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

/** Antwort-Envelope jedes IPC-Kanals. */
export const resultSchema = <T extends z.ZodType>(data: T) =>
  z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data }), z.object({ ok: z.literal(false), error: AppErrorInfo })]);
export type Result<T> = { ok: true; data: T } | { ok: false; error: AppErrorInfo };

/** Verweis auf ein Wissensobjekt für Kontextpanel, Quellen und Aktionen. */
export const EntityRef = z.object({
  type: EntityType,
  id: Id,
  label: z.string(),
  detail: z.string().nullish(),
});
export type EntityRef = z.infer<typeof EntityRef>;

export const SourceReference = z.object({
  id: Id,
  type: EntityType,
  title: z.string(),
  snippet: z.string().default(''),
  path: z.string().nullish(),
  date: z.string().nullish(),
  score: z.number().default(0),
});
export type SourceReference = z.infer<typeof SourceReference>;
