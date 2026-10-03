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

Liegt der neue Ordner in einem Ordner von OneDrive, Dropbox, iCloud Drive oder Google Drive, steht im Dialog eine Warnung: Dein Archiv würde dann auch beim Cloud-Anbieter liegen. Die Warnung blockiert nichts; dieselbe Warnung siehst du dauerhaft unter **Einstellungen → Archiv**, solange der aktuelle Archivordner in einem solchen Ordner liegt.

## Warum es keinen direkten Weg gibt

Sobald archivierte Dokumente existieren, lehnt Archivist jede andere Änderung des Archivordners ab, die nicht über „Archiv umziehen“ oder „Nur Pfad ändern“ läuft. Die Prüfung gilt im Hauptprozess und nicht nur in der Oberfläche: Die Einstellungen (`settings:update`) nehmen einen anderen `archiveRoot` dann nicht an und ändern dabei nichts, auch nicht die übrigen Felder derselben Änderung. So verlieren Dokumente nicht ihren Platz, und die Archivprüfung meldet nicht plötzlich alle Dateien als fehlend. Ohne archivierte Dokumente (etwa bei der Ersteinrichtung) lässt sich der Ordner weiterhin frei wählen; denselben Ordner erneut zu speichern ist immer möglich.
