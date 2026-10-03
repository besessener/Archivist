// `npm run db:generate` (scripts/db-generate.mjs) runs a pinned drizzle-kit outside the lockfile, next to the project's drizzle-orm.
export default {
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './migrations',
};
