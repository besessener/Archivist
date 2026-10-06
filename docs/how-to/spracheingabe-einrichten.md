# Spracheingabe einrichten und nutzen

Im Chat kannst du Nachrichten diktieren. Die Spracherkennung läuft vollständig auf deinem Rechner (Whisper); Aufnahmen werden weder gespeichert noch an ein LLM oder einen anderen Dienst gesendet.

## Modell wählen

Unter **Einstellungen → Profil → Spracheingabe** wählst du das Modell aus einer festen Liste:

| Modell | Für wen |
| --- | --- |
| `small` (Standard) | schnell und klein; reicht für Alltagssätze, macht aber eher Fehler bei Namen, Fachbegriffen und Zahlen |
| `medium` | genauer, deutlich langsamer, größerer Download |
| `turbo` | nahe an den größten Whisper-Modellen, schneller als `medium`, aber langsamer als `small` |

Die Liste zeigt die Größe jedes Modells und ob es schon heruntergeladen ist. Die Auswahl gilt sofort; jedes Modell liegt in einem eigenen Ordner, ein Wechsel überschreibt nichts. Ein Modell, das du nicht mehr brauchst, löschst du dort mit „Löschen“, um Platz freizugeben; du kannst es später erneut herunterladen.

## Einmalig einrichten

1. Klicke im Chat neben „Senden“ auf das Mikrofon („Spracheingabe einrichten“), oder wähle in den Einstellungen das Modell und klicke „Herunterladen“.
2. Bestätige den Download. Archivist lädt das gewählte Modell einmalig von `huggingface.co` in den Ordner `index/models/` des [Datenordners](../reference/datenverzeichnis.md). Das ist die einzige Verbindung der Spracheingabe nach außen; es gehen dabei keine Daten von dir hinaus.
3. Unter dem Eingabefeld und in den Einstellungen siehst du den Fortschritt und kannst den Download abbrechen. Archivist prüft jede Datei gegen eine feste Prüfsumme; eine beschädigte Datei wird verworfen, und es bleibt kein halbes Modell zurück. Es läuft immer nur ein Download.

Im Datenschutzmodus „nur lokal“ lädt Archivist nichts aus dem Internet: Stelle den Modus für den Download kurz um (siehe [Datenschutz einstellen](datenschutz-einstellen.md#spracheingabe)). Danach funktioniert die Spracheingabe in jedem Modus.

## Diktieren

1. Klicke auf das Mikrofon. Erlaubt Windows Desktop-Apps das Mikrofon nicht, sagt Archivist, wo du es freigibst (Einstellungen → Datenschutz & Sicherheit → Mikrofon).
2. Sprich. Unter dem Eingabefeld läuft die Aufnahmezeit mit; nach zwei Minuten endet die Aufnahme von selbst. „Verwerfen“ (oder die Taste Esc auf dem Mikrofon-Knopf) wirft sie weg.
3. Klicke noch einmal auf das Mikrofon. Die Aufnahme wird in Text umgewandelt und **hinten an dein Eingabefeld angehängt**. Archivist sendet nie von selbst: Du prüfst und korrigierst den Text und schickst ihn dann ab.

Erkannt wird Deutsch. Nur Stille oder ein versehentlicher Klick ergibt keinen Text („Ich habe nichts verstanden“).

## Wenn etwas nicht klappt

| Symptom | Lösung |
| --- | --- |
| Das Mikrofon erscheint nicht im Chat | Für das gewählte Modell nennt diese Version keinen Download („in dieser Version nicht verfügbar“ in den Einstellungen). Wähle ein anderes Modell. |
| „Archivist darf das Mikrofon nicht benutzen“ | Windows → Einstellungen → Datenschutz & Sicherheit → Mikrofon: „Desktop-Apps den Zugriff auf Ihr Mikrofon erlauben“ einschalten. |
| „Es wurde kein Mikrofon gefunden“ | Ein Mikrofon anschließen oder in Windows ein Standardgerät wählen. |
| Download schlägt fehl | Internetverbindung und Proxy prüfen und erneut versuchen; die Meldung steht unter dem Eingabefeld und in den Einstellungen. |
| Die Umwandlung dauert lange | Beim ersten Diktat lädt Archivist das Modell in den Arbeitsspeicher (mehrere hundert MB); es wird nach fünf Minuten ohne Diktat wieder freigegeben. Ein kleineres Modell antwortet schneller. |
