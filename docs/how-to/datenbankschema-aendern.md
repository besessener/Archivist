# Datenbankschema ändern

1. Ändere die Tabellen in `packages/core/src/db/tables/`. Eine neue Datei dort exportierst du zusätzlich in `packages/core/src/db/schema.ts` – nur was dort exportiert ist, sieht drizzle-kit.
2. Erzeuge die Migration:

   ```bash
   npm run db:generate
   ```

   Sie landet in `packages/core/migrations/`. Prüf das erzeugte SQL. Beim ersten Aufruf installiert das Skript (`scripts/db-generate.mjs`) drizzle-kit zusammen mit der drizzle-orm-Version des Projekts nach `node_modules/.cache/` – nicht ins Lockfile; dafür braucht es einmal Netzzugang. Ohne Schemaänderung meldet es „No schema changes, nothing to migrate“.
3. Für alles, was Drizzle nicht abbildet (z. B. die FTS5-Tabelle), schreibst du eine benutzerdefinierte Migration.
4. Starte die App oder die Tests. Beim Start werden Migrationen automatisch angewendet; `npm test` prüft die Migrationen gegen eine echte SQLite-Datenbank.

`packages/core/migrations/` ist von Prettier ausgenommen – generierte Dateien nicht von Hand formatieren.
