import { z } from 'zod';

/** Where the app update stands; `unsupported` carries the German reason (development build, portable version …). */
export const UpdateStatus = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unsupported'), reason: z.string() }),
  z.object({ state: z.literal('idle') }),
  z.object({ state: z.literal('checking') }),
  z.object({ state: z.literal('upToDate') }),
  z.object({ state: z.literal('available'), version: z.string() }),
  z.object({ state: z.literal('downloading'), version: z.string(), percent: z.number().min(0).max(100) }),
  z.object({ state: z.literal('downloaded'), version: z.string() }),
  z.object({ state: z.literal('error'), message: z.string() }),
]);
export type UpdateStatus = z.infer<typeof UpdateStatus>;
