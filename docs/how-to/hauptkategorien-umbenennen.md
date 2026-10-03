# Hauptkategorien auf Deutsch umstellen

Frühere Versionen haben Archive mit den Hauptkategorien `work` und `private` angelegt. Neue Archive beginnen mit `Arbeit` und `Privat`. Bei einem bestehenden Archiv stellst du die Namen einmalig selbst um; automatisch passiert das nie.

1. Öffne **Einstellungen → Archiv**. Der Abschnitt **Hauptkategorien auf Deutsch umstellen** erscheint nur, solange `work` oder `private` noch existiert.
2. Lies die Vorschau: welche Hauptkategorie wie heißen wird, wie viele Dateien verschoben werden und welche Dateien wegen eines Konflikts liegen bleiben.
3. Klicke **Hauptkategorien umbenennen …** und bestätige.

## Was dabei passiert

- Nur das erste Pfadsegment ändert sich: `work/projects/alpha` wird zu `Arbeit/projects/alpha`. Unterordner behalten ihren Namen.
- Die Dateien werden mit dem normalen [Umlagern](dokumente-umlagern.md) verschoben. Deine Originale außerhalb des Archivs bleiben unberührt.
- Nichts wird überschrieben oder stillschweigend zusammengeführt. Ist der Dateiname im Zielordner schon vergeben, bleibt die Datei im alten Ordner und wird gemeldet; die alte Hauptkategorie bleibt dafür bestehen.
- Dokumente ohne Archivdatei (nur indexiert) behalten ihren bisherigen Pfad.
- Jede Verschiebung steht einzeln im **Änderungsprotokoll** und lässt sich rückgängig machen. Ebenso das Entfernen der leer gewordenen alten Kategorien.
