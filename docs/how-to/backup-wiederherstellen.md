# Backup wiederherstellen

Ein Backup stellt die **Datenbank** wieder her (Entscheidungen, offene Punkte, Wissen, Verknüpfungen, Änderungsprotokoll). Bei einem vollständigen Backup kommen außerdem **fehlende** Archivdateien zurück; vorhandene Dateien werden nie überschrieben.

## Aus der laufenden Anwendung

1. Öffne **Einstellungen → Backups → Vorhandene Backups** und klick beim gewünschten Backup auf **Wiederherstellen**.
2. Bestätige den Dialog. Archivist bereitet die Wiederherstellung vor und startet neu.
3. Beim Start ersetzt das Backup die Datenbank. Die bisherige Datenbank bleibt unter `database/vor-wiederherstellung-<Zeitstempel>/` im Datenordner erhalten; ein Fehlgriff lässt sich also korrigieren, indem du diese Dateien zurückkopierst.

Änderungen seit dem Backup gehen in der Datenbank verloren. Dateien in deinem Archivordner werden nicht gelöscht.

## Wenn Archivist wegen einer beschädigten Datenbank nicht startet

Findet Archivist beim Start eine beschädigte Datenbank, meldet es das und bietet das neueste unbeschädigte Backup an (auch die Sicherungen, die vor Datenbank-Migrationen entstehen). Mit **Backup wiederherstellen** startet Archivist neu und setzt es ein; die beschädigte Datenbank bleibt im Datenordner. Gibt es kein Backup, bleiben deine Dokumente im Archivordner trotzdem unverändert – schreib dann in die [Fehlerbehebung](fehlerbehebung.md).

## Sicherung vor Migrationen

Vor einem Update, das die Datenbank umbaut, legt Archivist `backups/vor-migration-<Zeitstempel>.db` an (die drei neuesten bleiben). Sie erscheinen nicht unter „Vorhandene Backups“, werden aber bei beschädigter Datenbank angeboten. Eine Datenbank, die eine neuere Version von Archivist angelegt hat, öffnet Archivist nicht.

Backups anlegen: [Backups anlegen](backups-anlegen.md).
