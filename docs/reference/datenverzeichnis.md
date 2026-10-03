# Datenverzeichnis

Standardmäßig `~/Documents/Archivist/`, überschreibbar mit `ARCHIVIST_DATA_DIR`.

```
Archivist/
├── archive/       archivierte Dateien in menschenlesbaren Ordnern (Arbeit/Projekte/prod-plat/, Privat/Urlaub/2026/ …)
├── database/      archivist.db (SQLite, WAL)
├── index/         lokale Indexdaten (z. B. OCR-Sprachdaten unter tessdata/)
├── config/        settings.json (nicht geheim) und llm-api-key.enc (verschlüsselt)
├── logs/          strukturierte JSON-Logs (ohne Schlüssel/Dokumentinhalte); der Agent liest sie mit `read_logs`
├── backups/       Datenbank- und Metadaten-Backups
├── inbox/         Eingang: eigene Kopien hochgeladener Dateien bis zur Archivierung
├── quarantine/    Dateien, deren Inhalt nicht zur Endung passt
└── trash/         Papierkorb: eigene Kopien gelöschter Dokumente (trash/<id>/), bis du ihn leerst
```

## Ablage im Archiv

- Die Ablage bleibt **auch ohne Archivist verständlich**: keine Hash-/UUID-Ordner, keine reinen Dateityp-Ordner (`pdf/`, `docx/` …).
- Vorgeschlagene Pfade werden bereinigt. Unterkategorien darf der Agent vorschlagen, **neue Hauptkategorien** (erstes Pfadsegment) nur nach Bestätigung. Neu angelegte Archive beginnen mit den Hauptkategorien `Arbeit` und `Privat`; Groß-/Kleinschreibung zählt bei Kategorien nicht (wie unter NTFS), eine vorhandene Schreibweise wird übernommen.
- Archive aus früheren Versionen haben die englischen Hauptkategorien `work` und `private`. Sie bleiben unverändert, bis du sie unter Einstellungen → Archiv → „Hauptkategorien auf Deutsch umstellen“ umbenennen lässt (siehe [Hauptkategorien umbenennen](../how-to/hauptkategorien-umbenennen.md)); solange legt Archivist `Arbeit`/`Privat` nicht zusätzlich an.
- Archivdateien werden relativ zum Archivwurzelpfad referenziert (`archive_rel_path`). Der Archivordner kann deshalb umziehen, siehe [Archivpfad ändern](../how-to/archivpfad-aendern.md).

## Quarantäne

Dateien in `quarantine/` erscheinen in der Inbox unter „Quarantäne“: „Ordner öffnen“ oder nach Bestätigung „Trotzdem importieren“.

## Datenbank

- SQLite im WAL-Modus mit `synchronous=FULL`, Zugriff über better-sqlite3 + Drizzle.
- `restore-pending.json` im Datenordner merkt eine Wiederherstellung für den nächsten Start vor; danach liegt die ersetzte Datenbank unter `database/vor-wiederherstellung-<Zeitstempel>/` (mit `-wal`, falls vorhanden). Sie wird im Backups-Tab als Wiederherstellungsquelle angeboten und von der Aufbewahrungsregel nie gelöscht.
- Vor ausstehenden Migrationen legt Archivist eine Sicherung `backups/vor-migration-<Zeitstempel>.db` an (die drei neuesten bleiben); sie erscheint nicht unter „Vorhandene Backups“. Eine Datenbank, die eine neuere Version von Archivist angelegt hat, wird nicht geöffnet.
- Schema: `packages/core/src/db/schema.ts` (Tabellen in `db/tables/`); Migrationen in `packages/core/migrations/`, beim Start automatisch angewendet. Ändern: [Datenbankschema ändern](../how-to/datenbankschema-aendern.md).
- Die FTS5-Tabelle für die Stichwortsuche ist eine benutzerdefinierte Migration.
- Embeddings liegen als BLOB in SQLite. Zu einem Vektor des Embedding-Modells wird ein lokaler Hash-Vektor daneben gespeichert (`chunks.local_embedding`), damit die Suche ohne erreichbaren Endpunkt weiter greift.
- Die Tabelle `app_state` speichert u. a. den Zeitpunkt der letzten Archivprüfung.
