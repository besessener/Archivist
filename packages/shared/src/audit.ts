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
  personalRedactions: z.number(),
  documentIds: z.array(z.string()),
  /** The documents of `documentIds` with their current title; null once the document is gone. */
  documents: z.array(z.object({ id: z.string(), title: z.string().nullable() })),
  preview: z.string(),
  success: z.boolean(),
  /** Tokens per request (agent requests, #302). */
  inputTokens: z.number().nullish(),
  outputTokens: z.number().nullish(),
  cacheReadTokens: z.number().nullish(),
  /** POSTs the transmission took, retries included; absent in entries from before #153. */
  requests: z.number().int().optional(),
  /** Visible fallback of the request, e.g. „json_schema abgelehnt“. */
  note: z.string().nullish(),
});
export type LlmTransmission = z.infer<typeof LlmTransmission>;

export const UndoRunResult = z.object({ undone: z.number().int(), failed: z.number().int(), conflicts: z.array(z.string()), message: z.string() });
export type UndoRunResult = z.infer<typeof UndoRunResult>;

export const TokenTotals = z.object({
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cacheReadTokens: z.number().int(),
  /** input + cache + output */
  totalTokens: z.number().int(),
  requests: z.number().int(),
});
export type TokenTotals = z.infer<typeof TokenTotals>;

/** Token use of the LLM today and in this month (local time) and the state of the daily limit. */
export const LlmUsage = z.object({
  today: TokenTotals,
  month: TokenTotals,
  dailyCap: z.number().int().nullable(),
  capReached: z.boolean(),
});
export type LlmUsage = z.infer<typeof LlmUsage>;
