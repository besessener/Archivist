# Datenverzeichnis

Archivist trennt **deine Dokumente** vom **Zustand der Anwendung**:

- **Dokumentenordner** – standardmäßig `~/Documents/Archivist/` (unter Windows der Ordner „Dokumente“): Archiv, Eingang, Quarantäne und Papierkorb.
- **Datenordner der Anwendung** – standardmäßig der Datenordner deines Benutzerprofils (unter Windows `%APPDATA%\Archivist\`): Datenbank, Index, Einstellungen, Protokolle und Backups.

Der Grund: „Dokumente“ wird häufig von OneDrive, iCloud oder Dropbox mit der Cloud abgeglichen. Datenbank (mit dem Text aller Dokumente und dem Schreibprotokoll WAL), Protokolle und Backups gehören nicht dorthin – ein laufender Abgleich einer geöffneten SQLite-Datenbank kann sie außerdem beschädigen.

Mit `ARCHIVIST_DATA_DIR` liegt **alles** unter diesem einen Ordner (Entwicklung, Tests, eigene Laufwerksaufteilung); dann gibt es keine Trennung.

```
Dokumentenordner (Standard: ~/Documents/Archivist/)
├── archive/       archivierte Dateien in menschenlesbaren Ordnern (work/projects/prod-plat/, private/vacation/2026/ …)
├── inbox/         Eingang: eigene Kopien hochgeladener Dateien bis zur Archivierung
├── quarantine/    Dateien, deren Inhalt nicht zur Endung passt
├── trash/         Papierkorb: eigene Kopien gelöschter Dokumente (trash/<id>/), bis du ihn leerst
└── exports/       vom Agenten erzeugte Exportdateien

Datenordner der Anwendung (Standard: %APPDATA%\Archivist\)
├── database/      archivist.db (SQLite, WAL)
├── index/         lokale Indexdaten (z. B. OCR-Sprachdaten unter tessdata/)
├── config/        settings.json (nicht geheim) und llm-api-key.enc (verschlüsselt)
├── logs/          strukturierte JSON-Logs (ohne Schlüssel/Dokumentinhalte); der Agent liest sie mit `read_logs`
├── backups/       Datenbank- und Metadaten-Backups
└── layout-migration.json   Marker des einmaligen Umzugs aus der alten Ablage (siehe unten)
```

Der Archivordner selbst lässt sich getrennt davon verlegen: [Archivpfad ändern](../how-to/archivpfad-aendern.md). Liegt er in einem Ordner von OneDrive, Dropbox, iCloud Drive oder Google Drive (erkannt am Ordnernamen im Pfad), warnt Archivist in der Einrichtung, unter Einstellungen → Archiv und vor dem Ändern des Archivordners: Deine Dokumente lägen dann auch beim Cloud-Anbieter.

## Umzug aus der alten Ablage

Bis einschließlich der Vorversion lagen auch `database/`, `index/`, `config/`, `logs/` und `backups/` (und `restore-pending.json`) im Dokumentenordner. Beim ersten Start einer neuen Version zieht Archivist sie in den Datenordner der Anwendung um, **bevor** die Datenbank geöffnet wird:

1. Kopie in einen Zwischenordner `.layout-migration/` im Datenordner,
2. Prüfung jeder Datei per Größe und SHA-256 gegen das Original,
3. Marker `layout-migration.json` (Status `switching`), die geprüften Kopien werden an ihren Platz umbenannt,
4. erst danach werden die alten Ordner im Dokumentenordner entfernt; der Marker bekommt den Status `complete`.

Wird Archivist dazwischen beendet, setzt der nächste Start dort fort (ein unfertiger Zwischenordner wird neu angelegt). Archivist überschreibt dabei nie etwas: Liegt am Ziel schon eine Datenbank oder ein anderer Inhalt, bricht der Start mit einer Meldung ab und lässt alles unverändert. Archiv, Eingang, Quarantäne und Papierkorb bleiben, wo sie sind. Ist der Marker `complete`, passiert beim Start nichts mehr.

## Ablage im Archiv

- Die Ablage bleibt **auch ohne Archivist verständlich**: keine Hash-/UUID-Ordner, keine reinen Dateityp-Ordner (`pdf/`, `docx/` …).
- Vorgeschlagene Pfade werden bereinigt. Unterkategorien darf der Agent vorschlagen, **neue Hauptkategorien** (erstes Pfadsegment) nur nach Bestätigung.
- Archivdateien werden relativ zum Archivwurzelpfad referenziert (`archive_rel_path`). Der Archivordner kann deshalb umziehen, siehe [Archivpfad ändern](../how-to/archivpfad-aendern.md).

## Quarantäne

Dateien in `quarantine/` erscheinen in der Inbox unter „Quarantäne“: „Ordner öffnen“ oder nach Bestätigung „Trotzdem importieren“.

## Datenbank

- SQLite im WAL-Modus mit `synchronous=FULL`, Zugriff über better-sqlite3 + Drizzle.
- `restore-pending.json` im Datenordner der Anwendung merkt eine Wiederherstellung für den nächsten Start vor; danach liegt die ersetzte Datenbank unter `database/vor-wiederherstellung-<Zeitstempel>/`.
- Vor ausstehenden Migrationen legt Archivist eine Sicherung `backups/vor-migration-<Zeitstempel>.db` an (die drei neuesten bleiben); sie erscheint nicht unter „Vorhandene Backups“. Eine Datenbank, die eine neuere Version von Archivist angelegt hat, wird nicht geöffnet.
- Schema: `packages/core/src/db/schema.ts` (Tabellen in `db/tables/`); Migrationen in `packages/core/migrations/`, beim Start automatisch angewendet. Ändern: [Datenbankschema ändern](../how-to/datenbankschema-aendern.md).
- Die FTS5-Tabelle für die Stichwortsuche (`search_fts`) ist eine benutzerdefinierte Migration und ein **External-Content-Index über `chunks`**: Sie liest Titel und Text über die View `search_fts_source` aus `chunks.title` und `chunks.text`, speichert also nur den Index und keine zweite Kopie des Textes. Beim Einspielen der Migration auf ein bestehendes Archiv übernimmt sie die Titel aus dem alten Index und baut den neuen aus den Abschnitten auf; die Datenbank wird dadurch kleiner. Wer `chunks` ändert, muss die zugehörigen FTS-Zeilen vorher entfernen (`SearchService`). Der Volltext eines Dokuments steht zusätzlich in `documents.extracted_text` (für Anzeige und Analyse).
- Die Datenbank wächst mit dem Text der Dokumente (grob 50 bis 130 KB je Dokument mit mehreren Seiten Text). Jedes Metadaten-Backup ist eine volle Kopie davon, siehe [Backups anlegen](../how-to/backups-anlegen.md#speicherbedarf).
- Embeddings liegen als BLOB in SQLite. Zu einem Vektor des Embedding-Modells wird ein lokaler Hash-Vektor daneben gespeichert (`chunks.local_embedding`), damit die Suche ohne erreichbaren Endpunkt weiter greift.
- Die Tabelle `app_state` speichert u. a. den Zeitpunkt der letzten Archivprüfung.
