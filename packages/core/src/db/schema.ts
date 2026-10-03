// The database schema; drizzle-kit reads it from here (drizzle.config.ts), the tables live by area under tables/.
export type { Json } from './tables/columns';
export * from './tables/knowledge';
export * from './tables/documents';
export * from './tables/records';
export * from './tables/signals';
export * from './tables/agent';
export * from './tables/system';
