# Backup wiederherstellen

Ein Backup stellt die **Datenbank** wieder her (Entscheidungen, offene Punkte, Wissen, Verknüpfungen, Änderungsprotokoll). Bei einem vollständigen Backup kommen außerdem **fehlende** Archivdateien zurück; vorhandene Dateien werden nie überschrieben.

## Aus der laufenden Anwendung

1. Öffne **Einstellungen → Backups → Vorhandene Backups** und klick beim gewünschten Backup auf **Wiederherstellen**.
2. Bestätige den Dialog. Archivist bereitet die Wiederherstellung vor und startet neu.
3. Beim Start ersetzt das Backup die Datenbank. Die bisherige Datenbank bleibt unter `database/vor-wiederherstellung-<Zeitstempel>/` im Datenordner erhalten und erscheint danach unter **Vorhandene Backups** als „Stand vor der Wiederherstellung vom …“ (siehe unten). Das Änderungsprotokoll der wiederhergestellten Datenbank vermerkt die Wiederherstellung. Lässt sich die bisherige Datenbank nicht vollständig beiseitelegen (z. B. weil eine Datei gerade von einem anderen Programm geöffnet ist), wird nichts ersetzt; Archivist meldet das und startet beim nächsten Mal mit der bisherigen Datenbank.

Änderungen seit dem Backup gehen in der Datenbank verloren. Dateien in deinem Archivordner werden nicht gelöscht.

## Eine Wiederherstellung zurücknehmen

Hast du das falsche Backup erwischt, wähl unter **Vorhandene Backups** den Eintrag „Stand vor der Wiederherstellung vom …“ (mit dem Zeitpunkt der Wiederherstellung) und stell ihn wie jedes andere Backup wieder her. Dabei wird die gerade aktive Datenbank ihrerseits beiseitegelegt, du kannst also beliebig hin- und zurückwechseln. Diese Einträge löscht die Aufbewahrungsregel („Anzahl aufbewahrter Backups“) nie; wenn du sie nicht mehr brauchst, entferne den Ordner unter `database/` bei beendetem Archivist von Hand. Eine zur Datenbank gehörende `-wal`-Datei kommt beim Wiederherstellen mit.

Wiederherstellen und Prüfen verändern ein Backup nie: Archivist prüft eine Kopie, nicht das Backup selbst.

## Wenn Archivist wegen einer beschädigten Datenbank nicht startet

Findet Archivist beim Start eine beschädigte Datenbank, meldet es das und bietet das neueste unbeschädigte Backup an (auch die Sicherungen, die vor Datenbank-Migrationen entstehen). Erst mit **Backup wiederherstellen** wird es vorgemerkt; mit **Beenden** bleibt alles, wie es ist, etwa um die Datenbank erst selbst zu sichern. Mit **Backup wiederherstellen** startet Archivist neu und setzt es ein; die beschädigte Datenbank bleibt im Datenordner. Gibt es kein Backup, bleiben deine Dokumente im Archivordner trotzdem unverändert – schreib dann in die [Fehlerbehebung](fehlerbehebung.md).

## Sicherung vor Migrationen

Vor einem Update, das die Datenbank umbaut, legt Archivist `backups/vor-migration-<Zeitstempel>.db` an (die drei neuesten bleiben). Sie erscheinen nicht unter „Vorhandene Backups“, werden aber bei beschädigter Datenbank angeboten. Eine Datenbank, die eine neuere Version von Archivist angelegt hat, öffnet Archivist nicht.

Backups anlegen: [Backups anlegen](backups-anlegen.md).
