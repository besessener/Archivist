# Hauptkategorien auf Deutsch umstellen

Frühere Versionen haben Archive mit den Hauptkategorien `work` und `private` angelegt. Neue Archive beginnen mit `Arbeit` und `Privat`. Bei einem bestehenden Archiv stellst du die Namen einmalig selbst um; automatisch passiert das nie.

1. Öffne **Einstellungen → Archiv**. Der Abschnitt **Hauptkategorien auf Deutsch umstellen** erscheint nur, solange `work` oder `private` noch existiert.
2. Lies die Vorschau: welche Hauptkategorie wie heißen wird, wie viele Dateien verschoben werden und welche Dateien wegen eines Konflikts liegen bleiben.
3. Klicke **Hauptkategorien umbenennen …**. Weil dabei fast dein ganzes Archiv verschoben wird, ist das eine [besonders folgenreiche Aktion](../reference/aktionsstufen.md#stufen): Setze im Dialog das Häkchen „Ich verstehe, dass dabei fast alle Dateien im Archiv in neue Ordner verschoben werden.“ und bestätige mit **Umbenennen**.
4. Das Umbenennen läuft als Auftrag im Hintergrund. Im Abschnitt siehst du den Fortschritt („3 von 120 verschoben“) und am Ende das Ergebnis. Mit **Abbrechen** hältst du ihn zwischen zwei Dateien an; mit **Wiederholen** oder einem neuen Start geht es mit den restlichen Dateien weiter.

## Was dabei passiert

- Nur das erste Pfadsegment ändert sich: `work/projects/alpha` wird zu `Arbeit/projects/alpha`. Unterordner behalten ihren Namen.
- Die Dateien werden mit dem normalen [Umlagern](dokumente-umlagern.md) verschoben. Deine Originale außerhalb des Archivs bleiben unberührt.
- Verschoben werden nur Dateien, die tatsächlich in einem Ordner unter `work` oder `private` liegen. Hast du eine Datei von Hand in einen anderen Ordner gelegt und neu verknüpft, bleibt sie dort.
- Nichts wird überschrieben oder stillschweigend zusammengeführt. Ist der Dateiname im Zielordner schon vergeben, bleibt die Datei im alten Ordner und wird gemeldet; die alte Hauptkategorie bleibt dafür bestehen.
- Dokumente ohne Archivdatei (nur indexiert) behalten ihren bisherigen Pfad.
- Jede Verschiebung steht einzeln im **Änderungsprotokoll** und lässt sich rückgängig machen. Ebenso das Entfernen der leer gewordenen alten Kategorien.
- Brichst du ab, bleiben die bereits verschobenen Dateien in den neuen Ordnern und lassen sich ebenfalls rückgängig machen; die alten Kategorien bleiben, solange noch Dateien darin liegen.
