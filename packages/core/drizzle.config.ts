// Used by `npm run db:generate` (drizzle-kit is deliberately loaded only on demand via npx in a pinned version,
// so that its outdated dependencies do not end up in the lockfile).
export default {
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './migrations',
};
