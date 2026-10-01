// Wird von `npm run db:generate` genutzt (drizzle-kit wird bewusst nur bei Bedarf per npx in fester Version geladen,
// damit seine veralteten Abhängigkeiten nicht im Lockfile landen).
export default {
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './migrations',
};
