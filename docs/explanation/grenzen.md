# Bewusste Abweichungen und ehrliche Grenzen

Manches ist anders gebaut, als man erwarten würde, und manches kann Archivist bewusst nicht. Hier steht, was und warum.

## Eigener LLM-Client statt OpenAI-SDK

Für die Responses API nutzt Archivist einen typisierten Fetch-Client statt des offiziellen OpenAI-SDKs: volle Kontrolle über Timeouts, Fallbacks für Azure- und kompatible Endpunkte (z. B. das Weglassen abgelehnter Parameter) und keine zusätzliche Abhängigkeit. Das Responses-API-Format ist identisch. Für Claude im [Agentenmodus](../reference/agentenmodus.md#anbieter) wird dagegen das offizielle Anthropic-SDK verwendet.

## Vektorsuche ohne `sqlite-vec`

Embeddings liegen als BLOB in SQLite und werden im Worker-Pool durchsucht, statt eine native Erweiterung mitzuliefern. Ohne Embedding-Modell sind die lokalen Vektoren lexikalisch, nicht semantisch. Details: [Wie die Suche funktioniert](suche.md).

## XLSX ohne SheetJS

Die auf npm verfügbare Version von SheetJS hat bekannte, ungepatchte Schwachstellen. Archivist nutzt deshalb einen eigenen, kleinen ZIP/XML-Leser. Er liest Tabellenblätter als Text; Datumszellen erscheinen als Excel-Seriennummer, Formeln nur mit ihrem zuletzt gespeicherten Wert.

## OCR ohne Netz

Texterkennung läuft lokal mit `tesseract.js`; Sprachdaten liegen im Installationspaket. Das macht den Installer größer, aber ein gescanntes Dokument verlässt dafür nie den Rechner. PDFs werden seitenweise erkannt, aber höchstens 40 Seiten ohne Textebene je Dokument; weitere Seiten bleiben ungelesen und das Dokument zeigt das offen an („Text teilweise gelesen“). Details: [Funktionen – OCR](../reference/funktionen.md#ocr).

## Kein Betriebssystem-Sandkasten für Parser

Dateien aus unbekannter Quelle werden von pdfjs, mammoth, mailparser, sharp, canvas und tesseract in Worker-Threads **innerhalb des Electron-Hauptprozesses** gelesen, ohne Sandbox des Betriebssystems. Die Gegenmaßnahmen sind begrenzt: Zeitlimit je Aufgabe (der Worker wird beendet und ersetzt), Grenzen gegen ZIP-Bomben, lineare statt rückverfolgende Textsuche und Größenlimits für Dateien und Text. Ein Fehler in einer dieser Bibliotheken, der Code ausführt, wäre damit nicht eingedämmt. Ein Prozess mit eingeschränkten Rechten für das Einlesen ist ein bekanntes, bewusst nicht umgesetztes Thema; ein Beispiel für einen Angriff ist nicht bekannt.

## Kein Hintergrunddienst

Scans, Erinnerungen und Archivprüfungen laufen nur, **solange Archivist geöffnet ist**. Es gibt keinen Tray-Prozess, keinen Autostart und keinen Betriebssystemdienst, und die Anwendung behauptet nichts anderes. Damit die Archivprüfung trotzdem in einem verlässlichen Rhythmus läuft, wird der Zeitpunkt der letzten Prüfung gespeichert; das Intervall gilt über Neustarts hinweg.

## Löschen nur über den Papierkorb

Ein gelöschtes Dokument landet im Papierkorb und lässt sich wiederherstellen, bis du ihn leerst; erst das Leeren („Aus Archivist entfernen“) löscht endgültig, entfernt auch den gespeicherten Text und die Übertragungsvorschauen und braucht eine zweite Bestätigung; bereits angelegte Backups schreibt Archivist nicht um – siehe [Sicherheitsmodell](sicherheitsmodell.md#keine-datei-geht-verloren). Deine Originale außerhalb des Archivs löscht Archivist nie. Selbst erfasste Ereignisse lassen sich löschen; auch das ist über das Änderungsprotokoll rückgängig machbar.

## Widersprüche sind Hinweise

Die Widerspruchserkennung ist zurückhaltend: Ohne LLM erkennt sie nur lexikalische Gegensätze (z. B. weiterführen vs. nicht weiterführen oder pausieren, unterschiedliche Auswahl „für X/Y“); Verneinungen wie „nicht weiter“, „nicht fortsetzen“ oder „nicht starten“ lesen die Regeln als Stopp, „nicht pausieren, sondern weitermachen“ als Weiter. Stellen die Entscheidungen Mitarbeiter ein oder geben eine Bestellung auf, zählt das nicht als Stopp. Beträge, Daten und viele fachliche Entscheidungen prüft nur das LLM (Datenschutzmodus „automatisch“). Verglichen werden aktive Entscheidungen desselben Themas oder desselben Projekts, auch über Themen hinweg. Dokumente vergleicht die Prüfung nur im Datenschutzmodus „automatisch“ mit einem LLM (Kernaussagen zweier Dokumente desselben Themas oder Projekts, die inhaltlich zusammenpassen, höchstens 30 Fragen je Archivprüfung); ohne LLM, in „vorher fragen“ oder „nur lokal“ und für ausgeschlossene Dokumente findet sie keine Widersprüche zwischen Dokumenten. Das Ergebnis sind **Hinweise**, keine festgestellten Wahrheiten.

## Nur Windows, nur Deutsch

Archivist wird nur für Windows gebaut, getestet und gepflegt. Die Entwicklung mit `npm run dev` funktioniert meist auch anderswo, wird dort aber nicht zugesichert; Tests laufen in der CI auf Ubuntu. Die Oberfläche ist ausschließlich Deutsch.

## Kein Auto-Update

Releases werden als GitHub Release veröffentlicht, aber `electron-updater` ist nicht eingerichtet. Neue Versionen installierst du von Hand.
