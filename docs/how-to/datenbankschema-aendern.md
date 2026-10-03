# Datenbankschema ändern

1. Ändere die Tabellen in `packages/core/src/db/tables/`. Eine neue Datei dort exportierst du zusätzlich in `packages/core/src/db/schema.ts` – nur was dort exportiert ist, sieht drizzle-kit.
2. Erzeuge die Migration:

   ```bash
   npm run db:generate
   ```

   Sie landet in `packages/core/migrations/`. Prüf das erzeugte SQL. Beim ersten Aufruf installiert das Skript (`scripts/db-generate.mjs`) drizzle-kit zusammen mit der drizzle-orm-Version des Projekts nach `node_modules/.cache/` – nicht ins Lockfile; dafür braucht es einmal Netzzugang. Ohne Schemaänderung meldet es „No schema changes, nothing to migrate“.
3. Für alles, was Drizzle nicht abbildet (z. B. die FTS5-Tabelle), schreibst du eine benutzerdefinierte Migration.
4. Starte die App oder die Tests. Beim Start werden Migrationen automatisch angewendet; `npm test` prüft die Migrationen gegen eine echte SQLite-Datenbank.

## Journal-Regeln

Drizzle wendet eine Migration nur an, wenn ihr `when` im Journal (`packages/core/migrations/meta/_journal.json`) größer ist als das der zuletzt angewendeten. Eine Migration mit zu kleinem `when` würde beim Update eines bestehenden Archivs stillschweigend übersprungen. Deshalb gilt:

- `when` steigt streng monoton, `idx` läuft lückenlos von 0 an, und die Nummer im Namen (`NNNN_name`) ist gleich `idx`.
- Jeder Journal-Eintrag hat seine `NNNN_name.sql` und seinen `meta/NNNN_snapshot.json`; es liegt keine SQL-Datei ohne Journal-Eintrag im Ordner, und die `prevId`-Kette der Snapshots ist lückenlos.
- Bei einem Merge-Konflikt oder einer doppelt vergebenen Nummer benennst du deine Migration nicht um und gibst ihr kein älteres `when`: Du erzeugst sie mit `npm run db:generate` neu, sodass sie die nächste freie Nummer und ein späteres `when` als alles auf `main` bekommt.

`tests/unit/migration-journal.test.ts` (reine Prüfung in `tests/helpers/migration-journal.ts`) erzwingt das in `npm test` und damit in der CI. Eine Verletzung nennt die betroffene Migration im Klartext.

`packages/core/migrations/` ist von Prettier ausgenommen – generierte Dateien nicht von Hand formatieren.
