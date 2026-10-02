# Bewusste Abweichungen und ehrliche Grenzen

Manches ist anders gebaut, als man erwarten würde, und manches kann Archivist bewusst nicht. Hier steht, was und warum.

## Eigener LLM-Client statt OpenAI-SDK

Für die Responses API nutzt Archivist einen typisierten Fetch-Client statt des offiziellen OpenAI-SDKs: volle Kontrolle über Timeouts, Fallbacks für Azure- und kompatible Endpunkte (z. B. das Weglassen abgelehnter Parameter) und keine zusätzliche Abhängigkeit. Das Responses-API-Format ist identisch. Für Claude im [Agentenmodus](../reference/agentenmodus.md#anbieter) wird dagegen das offizielle Anthropic-SDK verwendet.

## Vektorsuche ohne `sqlite-vec`

Embeddings liegen als BLOB in SQLite und werden im Worker-Pool durchsucht, statt eine native Erweiterung mitzuliefern. Ohne Embedding-Modell sind die lokalen Vektoren lexikalisch, nicht semantisch. Details: [Wie die Suche funktioniert](suche.md).

## XLSX ohne SheetJS

Die auf npm verfügbare Version von SheetJS hat bekannte, ungepatchte Schwachstellen. Archivist nutzt deshalb einen eigenen, kleinen ZIP/XML-Leser. Er liest Tabellenblätter als Text; Datumszellen erscheinen als Excel-Seriennummer, Formeln nur mit ihrem zuletzt gespeicherten Wert.

## OCR ohne Netz

Texterkennung läuft lokal mit `tesseract.js`; Sprachdaten liegen im Installationspaket. Das macht den Installer größer, aber ein gescanntes Dokument verlässt dafür nie den Rechner. PDFs werden höchstens 40 Seiten tief erkannt. Details: [Funktionen – OCR](../reference/funktionen.md#ocr).

## Kein Hintergrunddienst

Scans, Erinnerungen und Archivprüfungen laufen nur, **solange Archivist geöffnet ist**. Es gibt keinen Tray-Prozess, keinen Autostart und keinen Betriebssystemdienst, und die Anwendung behauptet nichts anderes. Damit die Archivprüfung trotzdem in einem verlässlichen Rhythmus läuft, wird der Zeitpunkt der letzten Prüfung gespeichert; das Intervall gilt über Neustarts hinweg.

## Kein Löschen

Löschen (Stufe 3) ist bewusst nicht implementiert – siehe [Sicherheitsmodell](sicherheitsmodell.md#keine-datei-geht-verloren). Einzige Ausnahme sind Ereignisse, die du selbst erfasst hast; ihr Löschen ist über das Änderungsprotokoll rückgängig machbar.

## Widersprüche sind Hinweise

Die Widerspruchserkennung ist zurückhaltend: lexikalische Gegensätze (z. B. weiterführen vs. pausieren, unterschiedliche Auswahl „für X/Y“) plus optionale LLM-Bestätigung. Das Ergebnis sind **Hinweise**, keine festgestellten Wahrheiten.

## Nur Windows, nur Deutsch

Archivist wird nur für Windows gebaut, getestet und gepflegt. Die Entwicklung mit `npm run dev` funktioniert meist auch anderswo, wird dort aber nicht zugesichert; Tests laufen in der CI auf Ubuntu. Die Oberfläche ist ausschließlich Deutsch.

## Kein Auto-Update

Releases werden als GitHub Release veröffentlicht, aber `electron-updater` ist nicht eingerichtet. Neue Versionen installierst du von Hand.
