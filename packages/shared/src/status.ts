import { z } from 'zod';
import { AppErrorInfo } from './common';
import { AgentCapability } from './agent';

export const AppStatus = z.object({
  version: z.string(),
  dataRoot: z.string(),
  archiveRoot: z.string(),
  platform: z.string(),
  setupCompleted: z.boolean(),
  llm: z.object({
    configured: z.boolean(),
    hasApiKey: z.boolean(),
    status: z.enum(['unknown', 'ok', 'error']),
    lastError: z.string().nullable(),
    lastCheckedAt: z.string().nullable(),
  }),
  secretStorage: z.object({ available: z.boolean(), backend: z.string() }),
  jobs: z.object({ pending: z.number(), running: z.number(), failed: z.number() }),
  unreadNotifications: z.number(),
  openInsights: z.number(),
  services: z.array(z.object({ name: z.string(), status: z.enum(['ok', 'degraded', 'error']), detail: z.string().nullable() })),
});
export type AppStatus = z.infer<typeof AppStatus>;

export const LlmTestResult = z.object({
  ok: z.boolean(),
  latencyMs: z.number().nullable(),
  message: z.string(),
  modelReply: z.string().nullable(),
  error: AppErrorInfo.nullable(),
  /** Agent capability: adapter, native tool calling, streaming (#296, #297). */
  agent: AgentCapability.nullish(),
});
export type LlmTestResult = z.infer<typeof LlmTestResult>;
