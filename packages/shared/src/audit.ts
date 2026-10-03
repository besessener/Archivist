import { z } from 'zod';
import { Id, IsoDate } from './common';

export const AuditEntry = z.object({
  id: Id,
  at: IsoDate,
  action: z.string(),
  actor: z.enum(['user', 'agent']),
  trigger: z.string(),
  confirmed: z.boolean(),
  entityIds: z.array(z.string()),
  /** Titles of the affected entries that still exist (or are named in the entry itself). */
  entities: z.array(z.object({ id: Id, title: z.string() })),
  paths: z.array(z.string()),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  success: z.boolean(),
  error: z.string().nullable(),
  undoable: z.boolean(),
  undoneAt: IsoDate.nullable(),
  /** Agent run that made the change (#299). */
  runId: z.string().nullish(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

/** Audit check result: first non-fitting chained entry (null: intact); `truncated` = entries missing at either end. */
export const AuditVerification = z.object({ checked: z.number().int(), brokenEntryId: z.string().nullable(), truncated: z.boolean() });
export type AuditVerification = z.infer<typeof AuditVerification>;

export const LlmTransmission = z.object({
  id: Id,
  at: IsoDate,
  purpose: z.string(),
  model: z.string(),
  endpoint: z.string(),
  bytes: z.number(),
  redactions: z.number(),
  /** Of `redactions`: masked personal data; the rest are secrets. */
  personalRedactions: z.number().default(0),
  documentIds: z.array(z.string()),
  preview: z.string(),
  success: z.boolean(),
  /** Tokens per request (agent requests, #302). */
  inputTokens: z.number().nullish(),
  outputTokens: z.number().nullish(),
  cacheReadTokens: z.number().nullish(),
});
export type LlmTransmission = z.infer<typeof LlmTransmission>;

export const UndoRunResult = z.object({ undone: z.number().int(), failed: z.number().int(), conflicts: z.array(z.string()), message: z.string() });
export type UndoRunResult = z.infer<typeof UndoRunResult>;
