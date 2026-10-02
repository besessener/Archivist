# Datenschutz einstellen

So legst du fest, was Archivist an den LLM-Endpunkt senden darf.

## Modus wählen

Öffne **Einstellungen → Datenschutz → Datenschutzmodus**:

| Modus | Wirkung |
| --- | --- |
| `auto` | Inhalte automatisch analysieren |
| `confirm` (Standard) | vor jeder externen Analyse ausdrücklich bestätigen |
| `local_only` | nie extern – keine Klassifikation, keine Chat-Auswertung, keine Embeddings per LLM |

Die Auswahl wird sofort gespeichert; der aktive Modus steht darunter. Was die Modi im Einzelnen bewirken, steht in der [Referenz](../reference/aktionsstufen.md#llm-datenschutz).

## Ordner, Dateitypen oder Dateien ausschließen

Unter **Einstellungen → Datenschutz → Nie analysieren**:

- **Verzeichnisse** hinzufügen,
- **Dateitypen** mit Komma getrennt eintragen, z. B. `xlsx, eml`,
- **Einzelne Dateien** mit vollständigem Pfad, einer pro Zeile.

Was hier steht, geht nie an das LLM – unabhängig vom Modus. Ausschlüsse vergleichen auch den realen Pfad (Symlinks/Junctions) und ignorieren unter Windows die Groß-/Kleinschreibung.

Für einen gescannten Ordner geht es auch direkt beim Verzeichnis unter **Scan**: **KI-Analyse erlaubt** ausschalten. Entziehst du die Freigabe später, gilt das sofort für bereits erfasste Dokumente.

## Prüfen, was gesendet wurde

Unter **Einstellungen → Datenschutz → An die KI übertragene Inhalte** steht jede Übertragung mit Zeitpunkt, Zweck, Modell, Größe, Anzahl maskierter Stellen und einer gekürzten, maskierten Vorschau.

Hintergrund: [Sicherheits- und Datenschutzmodell](../explanation/sicherheitsmodell.md).
