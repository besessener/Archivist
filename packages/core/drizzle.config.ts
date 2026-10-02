// `npm run db:generate` loads drizzle-kit on demand via npx in a pinned version, keeping its outdated dependencies out of the lockfile.
export default {
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './migrations',
};
