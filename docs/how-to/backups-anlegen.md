# Backups anlegen

## Von Hand sichern

1. Öffne **Einstellungen → Backups → Backup erstellen**.
2. Klick auf
   - **Metadaten sichern** – Datenbank-Snapshot (Entscheidungen, offene Punkte, Wissen) und Einstellungen ohne API-Key, aber **nicht** die Dokumentdateien, oder
   - **Alles sichern** – zusätzlich alle archivierten Dokumentdateien.
3. Das Backup landet unter `~/Documents/Archivist/backups/` und erscheint unter **Vorhandene Backups**.

Ein vollständiges Backup schlägt fehl, wenn der Archivordner nicht erreichbar ist oder trotz archivierter Dokumente leer ist. Während der Kopie sind Archiv-Dateioperationen gesperrt.

## Automatisch sichern

Unter **Einstellungen → Backups → Optionen**:

- **Beim Start automatisch sichern** einschalten,
- **Automatische Backups enthalten das Archiv** – sonst nur Metadaten,
- **Anzahl aufbewahrter Backups** festlegen.

Ältere Backups über diese Anzahl hinaus werden nur nach einem erfolgreichen Backup entfernt, getrennt nach Art.

Wie ein Backup intern aufgebaut ist: [Funktionen – Backups](../reference/funktionen.md#backups).
