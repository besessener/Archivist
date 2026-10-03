# Datenschutz einstellen

So legst du fest, was Archivist an den LLM-Endpunkt senden darf.

## Modus wählen

Öffne **Einstellungen → Datenschutz → Datenschutzmodus**:

| Modus | Wirkung |
| --- | --- |
| `auto` | Inhalte automatisch analysieren; ein konfiguriertes Embedding-Modell bekommt auch deine Entscheidungen, Notizen, offenen Punkte und Ereignisse |
| `confirm` (Standard) | vor jeder externen Analyse ausdrücklich bestätigen |
| `local_only` | nie extern – keine Klassifikation, keine Chat-Auswertung, keine Embeddings per LLM |

Die Auswahl wird sofort gespeichert; der aktive Modus steht darunter. Wechselst du in „vorher fragen“ oder „nur lokal“ das Embedding-Modell, geht dadurch nichts hinaus: Lokal eingebettete Einträge bleiben lokal. Was die Modi im Einzelnen bewirken, steht in der [Referenz](../reference/aktionsstufen.md#llm-datenschutz).

## Begrenzen, wie viel Text an das Embedding-Modell geht

Mit einem Embedding-Modell im Modus `auto` geht der Text freigegebener Dokumente abschnittsweise an `/embeddings`. Wie viel davon, begrenzt **Einstellungen → KI → maximale Eingabegröße** (`llm.maxInputChars`, Standard 24 000 Zeichen): Pro Dokument gehen höchstens so viele Zeichen insgesamt hinaus, Titel jedes Abschnitts eingerechnet, vor der Maskierung. Der Rest des Dokuments bekommt nur lokale Vektoren. Willst du, dass von einem Dokument nur ein kleiner Anfang den Rechner verlässt, senke den Wert; willst du gar nichts senden, lass das Embedding-Modell leer oder wähle `confirm`.

## Ordner, Dateitypen oder Dateien ausschließen

Unter **Einstellungen → Datenschutz → Nie analysieren**:

- **Verzeichnisse** hinzufügen,
- **Dateitypen** mit Komma getrennt eintragen, z. B. `xlsx, eml`,
- **Einzelne Dateien** mit vollständigem Pfad, einer pro Zeile.

Was hier steht, geht nie an das LLM – unabhängig vom Modus. Das gilt auch für die Widerspruchsprüfung: Stammt eine der beiden Entscheidungen eines Paars aus einem ausgeschlossenen Dokument, fragt Archivist das LLM nicht, dann entscheiden nur die lexikalischen Regeln. Ein ausgeschlossenes Dokument wird außerdem nie mit einem anderen Dokument verglichen: Der Vergleich von Dokumenten läuft nur im Modus „automatisch“ und nur für freigegebene Dokumente. Ausschlüsse vergleichen auch den realen Pfad (Symlinks/Junctions) und ignorieren unter Windows die Groß-/Kleinschreibung.

Für einen gescannten Ordner geht es auch direkt beim Verzeichnis unter **Scan**: **KI-Analyse erlaubt** ausschalten. Entziehst du die Freigabe später, gilt das sofort für bereits erfasste Dokumente – auch in laufenden Chat-Gesprächen des Agenten: Was er vorher aus dem Dokument gelesen hat, geht mit der nächsten Nachricht nicht erneut an das LLM.

## Persönliche Daten maskieren

Unter **Einstellungen → Datenschutz → Persönliche Daten maskieren** (Standard: an) ersetzt Archivist vor jeder Übertragung IBAN, Kartennummern, Steuer-ID, Sozialversicherungsnummer und PINs durch Platzhalter wie `[IBAN]`. Das gilt auch für Embeddings, die Vorschau im Übertragungsprotokoll und das lokale Protokoll. Zugangsdaten und Schlüssel maskiert Archivist immer, unabhängig von diesem Schalter.

Nicht maskiert werden Gesundheitsdaten, Namen, Adressen, Telefonnummern und E-Mail-Adressen. Willst du, dass ein Dokument mit solchen Angaben nie hinausgeht, schließe es unter „Nie analysieren“ aus. Schaltest du die Maskierung aus, gehen die Kennungen im Klartext an die KI, sobald ein Dokument oder eine Nachricht gesendet werden darf.

## Verschlüsselte Verbindung sicherstellen

Archivist sendet nur über `https://` an einen fremden Rechner. Eine `http://`-Adresse ist nur für deinen eigenen Rechner erlaubt (`localhost`, `127.0.0.1`, `[::1]`, z. B. ein lokaler Ollama-Server). Trägst du unter **Einstellungen → KI** eine andere `http://`-Adresse ein, erscheint am Feld eine Meldung, und Speichern sowie der Verbindungstest bleiben gesperrt – verwende dann die `https://`-Adresse deines Anbieters. Der API-Key geht dabei immer nur in einem Header an den Endpunkt ([LLM-Schnittstelle](../reference/llm-schnittstelle.md#anfragen)).

Hatte eine ältere Version eine solche Adresse gespeichert, sendet Archivist nichts an sie und zeigt die Meldung, bis du sie korrigierst.

## Keine Cloud-Synchronisierung für deine Daten

Archivist hält Datenbank, Einstellungen, Protokolle und Backups im Datenordner deines Benutzerprofils (unter Windows `%APPDATA%\Archivist\`), nicht im Ordner „Dokumente“, den OneDrive, iCloud oder Dropbox oft abgleichen. Nur Archiv, Eingang, Quarantäne und Papierkorb liegen standardmäßig in `Dokumente\Archivist`. Die Dateien sind nicht zusätzlich verschlüsselt (nur der API-Key); schütze den Rechner mit Festplattenverschlüsselung (BitLocker).

Liegt dein Archivordner trotzdem in einem Sync-Ordner (OneDrive, Dropbox, iCloud Drive oder Google Drive, erkannt am Ordnernamen), warnt Archivist in der Einrichtung, unter **Einstellungen → Archiv** und im Dialog „Archivordner ändern“. Willst du, dass deine Dokumente den Rechner nicht verlassen, wähle einen Ordner außerhalb der Synchronisierung ([Archivpfad ändern](archivpfad-aendern.md)) oder nimm den Ordner in der Sync-Software von der Synchronisierung aus.

## Protokoll und Diagnose für den Agenten

Im Agentenmodus kann der Agent mit `read_logs` das lokale Protokoll und mit `diagnose` den Zustand von Archivist lesen ([Archivist untersuchen](../reference/agentenmodus.md#archivist-untersuchen)). Was er dabei liest, ist Teil seiner Anfrage an das LLM – du steuerst es so:

- **Protokoll:** Es enthält keine Schlüssel und keine Dokumentinhalte, aber Dateipfade und Fehlermeldungen. Zeilen, die ausgeschlossene Dateien, Ordner oder Dateitypen nennen, gibt `read_logs` nicht heraus. Alles andere geht, maskiert, an das LLM, sobald der Agent es liest. Das Protokoll selbst bleibt lokal; die Aufbewahrung stellst du unter Einstellungen → Protokolle (Stufe und Aufbewahrung) ein.
- **Endpunkt-Messung:** `diagnose` sendet nur im Modus „automatisch“ eine feste Testanfrage an den Embedding-Endpunkt. Sie enthält keinen Dokumentinhalt, steht mit Zweck „Diagnose: Embedding-Endpunkt“ im Übertragungsprotokoll und entfällt in „vorher fragen“ und „nur lokal“.

## Ein Dokument endgültig aus Archivist entfernen

Lege das Dokument im Dokument-Dialog „In den Papierkorb“ und wähle unter **Einstellungen → Archiv → Papierkorb** **Aus Archivist entfernen …**. Bis dahin lässt sich alles wiederherstellen. Nach der zweiten Bestätigung ist weg:

- die Archivdatei und die eigene Eingangskopie im Papierkorb (dein Original außerhalb von Archivist bleibt),
- der gespeicherte Text samt Zusammenfassung und Vorschlag, auch in den Undo-Daten des Änderungsprotokolls,
- die Vorschau der Übertragungen, an denen das Dokument beteiligt war (die Einträge selbst bleiben),
- die Reste in der Datenbank: Archivist verdichtet sie danach, was bei großen Archiven einige Sekunden dauert.

Es bleibt, was aus dem Dokument entstanden ist: Entscheidungen, offene Punkte, Notizen und Erkenntnisse. Lösche sie bei Bedarf einzeln. **Ältere Backups enthalten den Text weiterhin**; Archivist schreibt sie nicht um. Lösche sie unter Einstellungen → Backups, wenn auch dort nichts bleiben soll.

## Änderungsprotokoll

Das Änderungsprotokoll (Einstellungen → Änderungsprotokoll) bleibt lokal und geht nie an das LLM. Es hält bei Bearbeitungen von Entscheidungen Texte und Daten vorher und nachher fest und bei Einstellungsänderungen den alten und neuen Wert (Einstellungen enthalten keine Schlüssel; die liegen im Schlüsselspeicher). Gelöschte Entscheidungen bleiben als Undo-Daten im Protokoll gespeichert.

## Prüfen, was gesendet wurde

Unter **Einstellungen → Datenschutz → An die KI übertragene Inhalte** steht jede Übertragung mit Zeitpunkt, Zweck, Modell, Größe, Anzahl maskierter Stellen (bei persönlichen Daten mit dem Vermerk „davon … persönliche Daten“) den Titeln der beteiligten Dokumente und einer gekürzten, maskierten Vorschau. Die Vorschau zeigt, worum es ging: bei einer Chatfrage deine Frage und die Titel der Quellen, bei der Analyse eines Dokuments den Dateinamen und den Textanfang – nicht den festen Anfang der Anweisung. Die Liste zeigt die neuesten 100 Einträge; **Mehr laden** holt ältere. Einträge, die älter als 90 Tage sind, löscht Archivist beim Start und danach täglich. Ein Dokument, das du aus Archivist entfernt hast, erscheint als „entferntes Dokument“ und ohne Vorschau. Ein langes Dokument erscheint mit einem Eintrag je gelesenem Teil („Teil 2 von 4“), jeder maskiert und mit der Dokument-ID. Bei Agentenläufen zählt die Anzahl alle bis dahin im Lauf maskierten Stellen – in deiner Nachricht, in der Systemanweisung (Gelerntes, Profil) und in Werkzeugergebnissen.

Hintergrund: [Sicherheits- und Datenschutzmodell](../explanation/sicherheitsmodell.md).
