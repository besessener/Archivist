# Aktionsstufen und Schutzregeln

Was Archivist ohne Rückfrage darf, was eine Bestätigung braucht und wie Dateien geschützt werden. Warum es so gebaut ist: [Sicherheits- und Datenschutzmodell](../explanation/sicherheitsmodell.md).

## Stufen

| Stufe | Beispiele | Verhalten |
| --- | --- | --- |
| 1 – automatisch | Dateien in freigegebenen Ordnern auflisten, Metadaten/Prüfsummen, Textextraktion, Suchindex, Vorschläge, Insights, Benachrichtigungen | läuft ohne Rückfrage |
| 2 – Bestätigung | **Verschobene Archivdateien neu verknüpfen** (nur der hinterlegte Ort ändert sich, rückgängig machbar), **Backup wiederherstellen** (ersetzt die Datenbank beim nächsten Start; die bisherige bleibt erhalten), Kopieren/Verschieben ins Archiv, **Dokument in den Papierkorb legen** (rückgängig machbar), **bereits archivierte Dokumente in einen anderen Archivordner verschieben**, Umbenennen, neue Hauptkategorie, Entscheidung als überholt markieren, Widerspruch lösen, offenen Punkt schließen, Metadaten überschreiben, Themen/Einträge zusammenführen (rückgängig machbar) | Aktionskarte bzw. Dialog mit Quell- und Zielpfad, Begründung, Confidence; ohne `confirmed: true` abgelehnt |
| 3 – besonders | Umlagern von 20 oder mehr archivierten Dokumenten auf einmal; **Papierkorb leeren** (endgültiges Löschen); Überschreiben, automatisches Umsortieren des ganzen Archivs | siehe unten |

Im [Agentenmodus](agentenmodus.md#modi) führt der Modus „Auto“ Änderungen selbst aus und macht sie rückgängig machbar; die dort genannten Ausnahmen werden immer nachgefragt.

**Stufe 2 technisch**: Der Agent erzeugt *Vorschläge* (`agent_actions`) mit Begründung, Confidence und betroffenen Objekten. Ausführen kann sie nur `actions:resolve` mit `confirmed: true` – auf IPC-Ebene als `z.literal(true)` erzwungen.

**Stufe 3 im Einzelnen**

- **Umlagern ab 20 Dokumenten**: Karte „Besonders folgenreich“; ausgeführt erst nach einer zweiten, ausdrücklichen Bestätigung im Dialog – ein „ja“ im Chat genügt nicht. Umlagern ist nur für ausdrücklich genannte Dokumente möglich und wird immer vorher bestätigt.
- **Löschen nur über den Papierkorb**: „In den Papierkorb“ (Dokument-Dialog, oder der Agent mit `mark_duplicates`, dann immer als Vorschlag mit zweiter Bestätigung) verschiebt die Archivdatei und die eigene Eingangskopie mit Prüfsumme nach `trash/` im Datenordner – dein Original außerhalb des Archivs bleibt unberührt. Dokument, Suchtreffer und Verknüpfungen verschwinden und kommen mit „Wiederherstellen“ (Einstellungen → Archiv → Papierkorb) oder über das Änderungsprotokoll zurück. Liegt am ursprünglichen Ort inzwischen eine andere Datei, wird nichts überschrieben, sondern der Konflikt gemeldet.
- **Papierkorb leeren** („Aus Archivist entfernen“) löscht endgültig und braucht zwei Bestätigungen, im Schema erzwungen (`confirmed` und `permanentlyConfirmed`, beide `z.literal(true)`): den Dialog und das Häkchen „Ich verstehe, dass diese Dateien endgültig gelöscht werden“. Danach lassen sich diese Dokumente nicht mehr wiederherstellen; gelöscht wird nur, was im Papierkorb liegt. Dabei entfernt Archivist auch die Spuren des Textes: die Undo-Daten im Änderungsprotokoll (Dokumenttext, Zusammenfassung, Vorschlag), die Vorschauen der betroffenen Einträge im Übertragungsprotokoll und, nach einer Verdichtung der Datenbank, die freien Seiten, den Suchindex und das Schreibprotokoll der Datenbank. Entscheidungen, offene Punkte, Notizen und Erkenntnisse aus dem Dokument bleiben erhalten; Backups werden nicht umgeschrieben und enthalten den Text weiter, bis sie durch neuere ersetzt sind (Einstellungen → Backups).
- **Überschreiben und Umsortieren des ganzen Archivs** sind **nicht implementiert** – Archivist überschreibt keine Dateien.
- **Weitere Ausnahmen beim Löschen** sind von dir erfasste **Ereignisse** sowie **Entscheidungen im Status Entwurf oder Unklar** (z. B. irrtümlich angelegt, Kanal `decisions:delete` mit `confirmed: z.literal(true)`): Sie lassen sich nach Bestätigung löschen, und das Löschen lässt sich unter Einstellungen → Änderungsprotokoll rückgängig machen (Eintrag mit Thema, Projekt, Verknüpfungen und Suchtreffer; was inzwischen entfernt wurde, nennt die Meldung). Gültige Entscheidungen werden nur widerrufen.
- **Auch Undo löscht nie die einzige Kopie**: Als weitere Kopie zählt nur eine Datei mit gleicher Prüfsumme am Quell- bzw. Eingangsort. Fehlt sie, weil das Original seitdem bearbeitet oder entfernt wurde, legt Undo die archivierte Fassung an den Ursprungsort zurück, bei Namenskonflikt als `Name (2).ext`. Die Archivdatei wird erst entfernt, nachdem die Datenbank den Undo übernommen hat; scheitert das Entfernen, nennt die Meldung ihren Pfad. Schlägt die Datenbank fehl, bleibt die Archivierung bestehen, und ein erneuter Undo erkennt bereits wiederhergestellte Kopien (gleiche Prüfsumme) und läuft durch.

## Dateien

- Originale werden nie ohne ausdrückliche Bestätigung verändert. Standard ist *Kopieren*.
- Zieldateien werden mit `COPYFILE_EXCL` angelegt (kein Überschreiben, bei Namenskollision `Name (2).ext`) und per SHA-256 verifiziert. Erst danach werden – nur bei „Verschieben“ und zusätzlicher Bestätigung – Quellen entfernt.
- Pfade werden abgesichert gegen Traversal (`..`, absolute Pfade, Nullbytes), Symlink-Ausbruch (realpath-Prüfung) und ungültige Dateinamen (Windows-reservierte Namen, Sonderzeichen).
- Dateien, die sich seit der Analyse geändert haben, werden nicht archiviert.
- Vorgeschlagene Pfade werden bereinigt. Unterkategorien darf der Agent vorschlagen, **neue Hauptkategorien** (erstes Pfadsegment) nur nach Bestätigung.

## Teilfehler

- Bricht eine Kopie mittendrin ab (z. B. Datenträger voll), wird die Teilkopie entfernt; lässt sie sich nicht entfernen, nennt die Meldung ihren Pfad.
- Scheitert beim Umlagern das Entfernen der alten Datei (z. B. weil sie geöffnet ist), wird der neue Eintrag zurückgenommen. Bleibt er übrig (zusätzlicher Hardlink oder Kopie), steht das in der Meldung statt „nichts wurde verändert“.
- Der Eintrag im Änderungsprotokoll samt Undo-Daten wird in derselben Datenbank-Transaktion wie die Archivierung geschrieben, also vor dem Entfernen von Original oder Eingangskopie; scheitert er, wird alles zurückgenommen und keine Datei verändert; ein Abbruch dazwischen lässt die Dateien an Ort und Stelle und die Archivierung rückgängig machbar.
- Lässt sich nach dem Archivieren die eigene Kopie im Eingang nicht löschen, bleibt die Archivierung gültig und rückgängig machbar. Die Eingangskopie wird vorgemerkt und beim nächsten Archivieren, bei der Archivprüfung oder beim nächsten Start entfernt – nur, wenn sie unverändert ist und die Archivdatei intakt. Dateien im Eingang, auf die kein Dokument mehr verweist (z. B. nach einem Absturz beim Import), entfernt dieselbe Aufräumroutine beim Start und bei der Archivprüfung nur, wenn gerade keine andere Dateiaktion läuft, sie seit mehr als einer Stunde im Eingang liegen (gemessen am jüngsten Zeitstempel der Datei, denn eine Kopie behält unter Windows das Änderungsdatum des Originals) und eine intakte Archivdatei mit gleichem Inhalt existiert; alle anderen bleiben liegen und werden im Protokoll gezählt. Dateiaktionen, die währenddessen starten, warten, bis die Aufräumroutine fertig ist.
- Ein Umlager-Vorschlag, bei dem nichts verschoben wurde, gilt als fehlgeschlagen: Der Hinweis bleibt offen und erhält bei der nächsten Archivprüfung einen neuen Vorschlag.

## Scans

- Nur ausdrücklich freigegebene Verzeichnisse. Wurzeln, Systemverzeichnisse und Verzeichnisse anderer Benutzer werden abgelehnt; das Archivist-Datenverzeichnis wird nie gescannt.
- Symlinks werden nur verfolgt, wenn ihr Ziel im freigegebenen Bereich liegt. Versteckte Einträge und `node_modules` werden übersprungen.
- Bekannte, unveränderte Dateien (Größe + Änderungszeit) werden weder neu gehasht noch analysiert.
- Dateien, deren Inhalt bereits als Dokument im Eingang oder im Archiv liegt (auch als Upload, in einer anderen Wurzel oder als „x (1).pdf“), werden als Duplikat markiert statt erneut angelegt.
- Ändert sich eine gescannte Datei, deren Dokument noch im Eingang liegt, aktualisiert die nächste Analyse diesen Eintrag.
- Pro Wurzel werden höchstens 20.000 Dateien erfasst. Wird das Limit erreicht, erscheint ein Hinweis; Dateien hinter dem Limit oder in (vorübergehend) nicht lesbaren Ordnern gelten nicht als verschwunden.

## LLM-Datenschutz

Einstellungen → Datenschutz. Bedienung: [Datenschutz einstellen](../how-to/datenschutz-einstellen.md).

| Modus | Verhalten |
| --- | --- |
| `auto` | Inhalte automatisch analysieren |
| `confirm` (Standard) | vor jeder externen Analyse ausdrücklich bestätigen |
| `local_only` | nie extern: keine Klassifikation, keine Chat-Auswertung, keine Embeddings per LLM |

- **Ausschlüsse**: Verzeichnisse, Dateitypen und einzelne Dateien lassen sich dauerhaft von der LLM-Verarbeitung ausschließen. Verglichen wird auch der reale Pfad (Symlinks/Junctions); unter Windows ohne Beachtung der Groß-/Kleinschreibung.
- **Sichtbare Zustände** in der Oberfläche: *nur lokal gescannt · zur LLM-Analyse vorgesehen · per LLM analysiert · von externer Analyse ausgeschlossen*.
- **„KI-Analyse erlaubt“ eines Scan-Verzeichnisses** wird am Dokument gespeichert (auch für Dateien, die aus diesem Ordner hochgeladen werden) und gilt für Analyse, „Erneut verarbeiten“, Chat-Quellen, Lösungsvorschläge und Embeddings. Wird die Freigabe später entzogen, gilt das sofort für bereits erfasste Dokumente.
- **Im Modus `confirm`** fragt auch „Erneut verarbeiten“ vor der Übertragung nach. Chat-Antworten senden nur Dokumente, die zur externen Analyse freigegeben wurden; andere passende Dokumente werden nur lokal als Quelle aufgeführt. Suchindex und Suchanfragen nutzen ausschließlich lokale Vektoren.
- **Maskierung**: Vor jeder Übertragung werden Zugangsdaten und Geheimnisse maskiert – Passwörter (auch in Anführungszeichen mit Leerzeichen), API-Keys inkl. Google-Keys, Tokens, JWTs, private Schlüssel, Zugangsdaten in URLs sowie Schlüssel und Passwörter in Verbindungsstrings wie `AccountKey=…;`, `SharedAccessKey=…;` oder `Password=…;`. Als Schlüsselname gilt `key`, `secret` oder `token` allein, mit Trennzeichen davor (`api_key`, `x-api-key`) oder nach einem bekannten Präfix (`accountkey`, `authToken`, `AppSecret`); Wörter wie „Monkey:“ oder „Hockey:“ bleiben unberührt.
- **Persönliche Daten** (Einstellung `privacy.maskPersonalData`, Standard an): Dazu kommen typisierte Platzhalter für IBAN (`[IBAN]`, Prüfsumme mod 97), Kartennummern (`[KARTENNUMMER]`, Luhn), Steuer-ID (`[STEUER-ID]`), Sozialversicherungsnummer (`[SV-NUMMER]`), `PIN`/`PUK`/`TAN` mit Ziffern (`[PIN]`) und ein Kennwort ohne Trennzeichen wie „Kennwort Geheim123“ (`[KENNWORT]`). Zahlen, deren Prüfziffer nicht stimmt, bleiben lesbar. Die Regeln gelten für Anfragen an das LLM, Embeddings, die Vorschau im Übertragungsprotokoll, die Werkzeugergebnisse und Systemanweisungen des Agenten und das lokale Protokoll. **Nicht maskiert** werden Gesundheitsdaten, Namen, Adressen, Telefonnummern und E-Mail-Adressen; die Oberfläche sagt das unter Einstellungen → Datenschutz. Was nicht hinausgehen soll, schließt du über „Nie analysieren“ aus.
- **Übertragungsprotokoll**: Jede Übertragung wird mit Zeitpunkt, Zweck, Modell, Größe, Anzahl maskierter Stellen (getrennt nach Geheimnissen und persönlichen Daten) gekürzter, maskierter Vorschau sowie den gemeldeten Tokens, der Zahl der Anfragen und gegebenenfalls einem Hinweis auf eine mildere Anfrage (z. B. JSON-Modus statt Structured Outputs) protokolliert (Einstellungen → Datenschutz → „An die KI übertragene Inhalte“).
- Gesendet wird mit `store: false`, siehe [LLM-Schnittstelle](llm-schnittstelle.md#anfragen).

## Electron

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, kein `eval`.
- Navigation und `window.open` gesperrt, Berechtigungsanfragen abgelehnt.
- Auslieferung über ein eigenes `app://`-Protokoll (kein HTTP-Server, kein `file://`) mit strenger CSP: `default-src 'none'`, Skripte nur `self` + SHA-256-Hashes der von Next.js erzeugten Inline-Skripte, `connect-src 'self'`.
- IPC: explizite Kanal-Allowlist, Absender-Prüfung (Frame-URL + WebContents), Zod-Validierung von Ein- **und** Ausgaben.
- Der Renderer hat keinen Zugriff auf Node, Dateisystem, Datenbank, Shell oder Credential Store. Dateien öffnet nur der Main-Prozess und nur solche, die Archivist kennt.

## Geheimnisse

- Der API-Key wird ausschließlich über Electron `safeStorage` (Windows DPAPI) verschlüsselt in `config/llm-api-key.enc` abgelegt – nie in `settings.json`, Datenbank, Backups oder Logs.
- Der Logger maskiert bekannte Schlüssel zusätzlich aktiv.
- Ist kein sicherer Speicher verfügbar, **verweigert** Archivist das Speichern.
