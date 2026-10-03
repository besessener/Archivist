import { z } from 'zod';

export const Empty = z.object({});
export const Ok = z.object({ ok: z.literal(true) });

export const Confirmed = z.literal(true).describe('Ausdrückliche Bestätigung des Benutzers (Pflicht)');

export const channel = <Input extends z.ZodType, Output extends z.ZodType>(input: Input, output: Output) => ({ input, output });
