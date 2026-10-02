# Datenbankschema ändern

1. Ändere das Drizzle-Schema in `packages/core/src/db/schema.ts`.
2. Erzeuge die Migration:

   ```bash
   npm run db:generate
   ```

   Sie landet in `packages/core/migrations/`. Prüf das erzeugte SQL.
3. Für alles, was Drizzle nicht abbildet (z. B. die FTS5-Tabelle), schreibst du eine benutzerdefinierte Migration.
4. Starte die App oder die Tests. Beim Start werden Migrationen automatisch angewendet; `npm test` prüft die Migrationen gegen eine echte SQLite-Datenbank.

`packages/core/migrations/` ist von Prettier ausgenommen – generierte Dateien nicht von Hand formatieren.
