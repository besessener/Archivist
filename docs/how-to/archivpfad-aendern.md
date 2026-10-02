# Archivpfad ändern

Archivierte Dokumente verweisen auf ihren Platz *innerhalb* des Archivordners (`archive_rel_path`). Deshalb bietet Archivist beim Ändern zwei Wege an.

1. Öffne **Einstellungen → Archiv** und wähl einen neuen Archivordner.
2. Entscheide dich:

**„Archiv umziehen“** – der Archivordner soll an einen neuen Ort.

- Archivist kopiert den gesamten Archivordner als Hintergrundaufgabe mit Fortschrittsanzeige in den neuen Ordner. Nichts wird überschrieben, jede Kopie wird per Prüfsumme geprüft.
- Erst danach wird umgestellt. Der bisherige Ordner bleibt unverändert erhalten.
- Der Umzug lässt sich rückgängig machen; die unveränderten Kopien werden dabei wieder entfernt.
- Während des Umzugs sind Archivieren und Umlagern gesperrt.

**„Nur Pfad ändern“** – die Dateien liegen schon am neuen Ort (z. B. selbst kopiert oder auf ein anderes Laufwerk verschoben).

- Archivist prüft vorher, ob alle archivierten Dokumente im neuen Ordner vorhanden sind.
- Fehlen Dateien, stellt Archivist nur nach ausdrücklicher Bestätigung um und nennt die Anzahl betroffener Dokumente. Solange sie nicht erreichbar sind, warnt die Oberfläche weiter.

Oder **Abbrechen**.
