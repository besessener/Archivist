# Backups anlegen

## Von Hand sichern

1. Öffne **Einstellungen → Backups → Backup erstellen**.
2. Klick auf
   - **Metadaten sichern** – Datenbank-Snapshot (Entscheidungen, offene Punkte, Wissen) und Einstellungen ohne API-Key, aber **nicht** die Dokumentdateien, oder
   - **Alles sichern** – zusätzlich alle archivierten Dokumentdateien.
3. Das Backup landet im Ordner `backups/` des [Datenordners der Anwendung](../reference/datenverzeichnis.md) (unter Windows `%APPDATA%\Archivist\backups\`, bewusst nicht im synchronisierten Ordner „Dokumente“) und erscheint unter **Vorhandene Backups**.

Ein vollständiges Backup schlägt fehl, wenn der Archivordner nicht erreichbar ist oder trotz archivierter Dokumente leer ist. Während der Kopie sind Archiv-Dateioperationen gesperrt.

## Automatisch sichern

Unter **Einstellungen → Backups → Optionen**:

- **Beim Start automatisch sichern** einschalten,
- **Automatische Backups enthalten das Archiv** – sonst nur Metadaten,
- **Anzahl aufbewahrter Backups** festlegen (Standard: 3 je Art; ein früher gespeicherter Wert bleibt bestehen).

Ältere Backups über diese Anzahl hinaus werden nur nach einem erfolgreichen Backup entfernt, getrennt nach Art.

## Speicherbedarf

Ein Metadaten-Backup ist eine volle Kopie der Datenbank, und die wächst mit dem Text deiner Dokumente (grob 50 bis 130 KB je Dokument mit mehreren Seiten Text). Bei 3 aufbewahrten Backups je Art belegen die Backups also etwa das Dreifache der Datenbank, bei vollständigen Backups zusätzlich das Archiv.

Unter **Einstellungen → Backups → Speicherbedarf** siehst du die Größe der Datenbank und aller Backups zusammen. Ab 2 GB (aktuell belegt oder bei der eingestellten Anzahl möglich) erscheint eine Warnung; senke dann die **Anzahl aufbewahrter Backups** oder prüfe den freien Platz auf dem Laufwerk des Datenordners.

## Nach einem Update zur alten Datenbank zurückkehren

Vor ausstehenden Migrationen legt Archivist selbst eine Sicherung `backups/vor-migration-<Zeitstempel>.db` an. Läuft eine neue Version nicht richtig mit deinem Archiv:

1. Beende Archivist.
2. Benenne im Ordner `database/` des Datenordners der Anwendung (unter Windows `%APPDATA%\Archivist\database\`) die Dateien `archivist.db`, `archivist.db-wal` und `archivist.db-shm` um (z. B. in `archivist-neu.db` …) – lösch sie nicht.
3. Kopiere die neueste `backups/vor-migration-<Zeitstempel>.db` nach `database/archivist.db`.
4. Installiere die vorherige Version von Archivist aus den [GitHub Releases](https://github.com/besessener/Archivist/releases) und starte sie. Die neue Version würde die Sicherung beim Start gleich wieder migrieren.

Was du seit dem Update geändert hast, steht nur in der umbenannten Datenbank. Seither archivierte Dateien bleiben im Archiv liegen; die alte Datenbank kennt sie nicht, und die Archivprüfung zeigt sie als nicht erfasst.

Wie ein Backup intern aufgebaut ist: [Funktionen – Backups](../reference/funktionen.md#backups).
