import { z } from 'zod';
import { Id, IsoDate } from './common';

export const EventRecord = z.object({
  id: Id,
  title: z.string(),
  description: z.string().nullable(),
  occurredAt: IsoDate,
  topicId: z.string().nullable(),
  topicName: z.string().nullable(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  /** Names of the persons involved (canonical names, like decision participants). */
  participants: z.array(z.string()),
  sourceIds: z.array(z.string()),
  createdAt: IsoDate,
  updatedAt: IsoDate,
  /** Discarded as a duplicate („verworfen (Duplikat)“): the event it was merged into. */
  duplicateOfId: z.string().nullable(),
});
export type EventRecord = z.infer<typeof EventRecord>;
export const EventInput = z.object({
  title: z.string().min(1),
  description: z.string().nullish(),
  occurredAt: IsoDate,
  topic: z.string().nullish(),
  project: z.string().nullish(),
  /** Persons involved; left out = unchanged on update. */
  participants: z.array(z.string()).optional(),
  sourceIds: z.array(z.string()).default([]),
});
export type EventInput = z.infer<typeof EventInput>;
