import { text } from 'drizzle-orm/sqlite-core';

/** A JSON column's value type (documents the stored shape). */
export type Json<T> = T;

/** A JSON array of strings, never null (default: empty). */
export const jsonArr = (name: string) => text(name, { mode: 'json' }).$type<string[]>().notNull().default([]);
