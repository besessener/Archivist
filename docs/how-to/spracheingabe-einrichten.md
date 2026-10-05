# Spracheingabe einrichten und nutzen

Im Chat kannst du Nachrichten diktieren. Die Spracherkennung läuft vollständig auf deinem Rechner (Whisper); Aufnahmen werden weder gespeichert noch an ein LLM oder einen anderen Dienst gesendet.

## Einmalig einrichten

1. Klicke im Chat neben „Senden“ auf das Mikrofon („Spracheingabe einrichten“).
2. Bestätige den Download. Archivist lädt einmalig das Spracherkennungsmodell (rund 250 MB) von `huggingface.co` in den Ordner `index/models/` des [Datenordners](../reference/datenverzeichnis.md). Das ist die einzige Verbindung der Spracheingabe nach außen; es gehen dabei keine Daten von dir hinaus.
3. Unter dem Eingabefeld siehst du den Fortschritt und kannst den Download abbrechen. Archivist prüft jede Datei gegen eine feste Prüfsumme; eine beschädigte Datei wird verworfen, und es bleibt kein halbes Modell zurück.

Im Datenschutzmodus „nur lokal“ lädt Archivist nichts aus dem Internet: Stelle den Modus für den Download kurz um (siehe [Datenschutz einstellen](datenschutz-einstellen.md#spracheingabe)). Danach funktioniert die Spracheingabe in jedem Modus.

## Diktieren

1. Klicke auf das Mikrofon. Beim ersten Mal fragt Windows nicht nach; erlaubt Windows Desktop-Apps das Mikrofon nicht, sagt Archivist, wo du es freigibst (Einstellungen → Datenschutz & Sicherheit → Mikrofon).
2. Sprich. Unter dem Eingabefeld läuft die Aufnahmezeit mit; nach zwei Minuten endet die Aufnahme von selbst. „Verwerfen“ (oder die Taste Esc auf dem Mikrofon-Knopf) wirft sie weg.
3. Klicke noch einmal auf das Mikrofon. Die Aufnahme wird in Text umgewandelt und **hinten an dein Eingabefeld angehängt**. Archivist sendet nie von selbst: Du prüfst und korrigierst den Text und schickst ihn dann ab.

Erkannt wird Deutsch. Nur Stille oder ein versehentlicher Klick ergibt keinen Text („Ich habe nichts verstanden“).

## Wenn etwas nicht klappt

| Symptom | Lösung |
| --- | --- |
| „Archivist darf das Mikrofon nicht benutzen“ | Windows → Einstellungen → Datenschutz & Sicherheit → Mikrofon: „Desktop-Apps den Zugriff auf Ihr Mikrofon erlauben“ einschalten. |
| „Es wurde kein Mikrofon gefunden“ | Ein Mikrofon anschließen oder in Windows ein Standardgerät wählen. |
| Download schlägt fehl | Internetverbindung und Proxy prüfen und erneut versuchen; die Meldung steht unter dem Eingabefeld. |
| Die Umwandlung dauert lange | Beim ersten Diktat lädt Archivist das Modell in den Arbeitsspeicher (mehrere hundert MB); es wird nach fünf Minuten ohne Diktat wieder freigegeben. |
