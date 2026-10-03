# LLM-Schnittstelle

Wie Archivist mit dem LLM-Endpunkt spricht. Einrichtung: [LLM-Anbieter verbinden](../how-to/llm-anbieter-verbinden.md). Für den Agentenmodus mit Werkzeugen siehe [Agentenmodus](agentenmodus.md#anbieter).

## Einstellungen

Konfigurierbar (nichts davon ist im Code verdrahtet):

| Einstellung | Schlüssel in `settings.json` |
| --- | --- |
| Base URL | `llm.baseUrl` |
| API-Key | nicht in `settings.json`, siehe [Geheimnisse](aktionsstufen.md#geheimnisse) |
| Modellname | `llm.model` |
| Reasoning effort (optional) | `llm.reasoningEffort`: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` oder leer (Standard des Modells), siehe [Denktiefe](#denktiefe) |
| Tageslimit für Tokens (optional) | `llm.dailyTokenCap` (Eingabe + Ausgabe, mindestens 1 000; leer = kein Limit), siehe [Tokenverbrauch und Tageslimit](#tokenverbrauch-und-tageslimit) |
| Timeout | `llm.timeoutMs` |
| maximale Eingabegröße | `llm.maxInputChars` (zu lange Eingaben werden in der Mitte gekürzt, Anfang und Ende bleiben; die Klassifikation eines Dokuments teilt lange Texte stattdessen in Teile, siehe [Lange Dokumente](#lange-dokumente); für Embeddings gilt sie als Obergrenze je Eintrag, siehe [Anfragen](#anfragen)) |
| Embedding-Modell (optional) | `llm.embeddingModel` |
| persönliche Daten maskieren | `privacy.maskPersonalData` (Standard an; Details unter [Maskierung](aktionsstufen.md#llm-datenschutz)) |

## Anfragen

- Verwendet wird die OpenAI-kompatible **Responses API**: `POST {baseUrl}/responses`, z. B. mit `https://<resource>.openai.azure.com/openai/v1`.
- Authentifizierung: Der API-Key geht in genau **einem** Header. Hosts unter `azure.com` (auch `azure.us`, `azure.cn`) bekommen `api-key`, jeder andere Endpunkt `Authorization: Bearer`. Die Anthropic Messages API geht über das offizielle SDK und damit mit dessen Header. Ein Azure-Endpunkt hinter einer eigenen Domain (z. B. API-Gateway) wird nicht als Azure erkannt und bekommt `Authorization: Bearer`.
- Base URL: `https://` ist immer erlaubt, `http://` nur für den eigenen Rechner (`localhost`, `127.0.0.0/8`, `[::1]`), z. B. ein lokaler Ollama-Server. Jede andere `http://`-Adresse – auch `http://localhost.example.com` oder `http://127.0.0.1.example.com` – wird abgelehnt, weil sonst der API-Key und Dokumentinhalte im Klartext durchs Netz gehen. Leer bedeutet „nicht konfiguriert“.
- Die Regel gilt in der Oberfläche (Meldung am Feld, Speichern und Verbindungstest gesperrt), beim Speichern der Einstellungen im Hauptprozess (die Oberfläche kann das nicht umgehen) und in jedem LLM-Aufruf, auch im Verbindungstest. Steht aus einer älteren Version noch eine nicht erlaubte Adresse in `settings.json`, startet Archivist normal; jeder Aufruf scheitert dann ohne etwas zu senden mit der Fehlermeldung (Kategorie `validation_error`), bis du die Adresse korrigierst.
- Vor dem Senden läuft jede Anfrage (Eingabe und Anweisungen, ebenso jeder Embedding-Text) durch die Maskierung: Zugangsdaten und Schlüssel immer, IBAN, Kartennummern, Steuer-ID, Sozialversicherungsnummer und PINs solange `privacy.maskPersonalData` an ist. Das Übertragungsprotokoll zählt beides getrennt (`redactions` insgesamt, `personalRedactions` davon persönliche Daten). Gesundheits- und Kontaktdaten werden nicht maskiert.
- **Übertragungsprotokoll:** Jede Übertragung wird mit Zweck, Modell, Größe, Zahl der maskierten Stellen (insgesamt und davon persönliche Daten) und einer Vorschau gespeichert (Tabelle `llm_transmissions`). Die Vorschau ist höchstens 280 Zeichen lang und maskiert. Eine Anfrage kann sie selbst festlegen (`preview`): Die Wissensabfrage nennt die Frage und die Titel der Quellen, die Dokumentklassifikation den Dateinamen und den Textanfang; ohne eigene Vorschau steht der gesendete Text ohne die festen Zeilen „Antworte als JSON.“ und „Heutiges Datum“. Die Titel der beteiligten Dokumente liest `llm:transmissions` beim Abruf aus den Dokumenten (`documents`: `id`, `title`, `null` für ein entferntes Dokument). Der Kanal liefert die neuesten Einträge zuerst und blättert mit `limit` (1–500, Standard 100) und `offset`. Einträge, die älter als 90 Tage sind, löscht Archivist beim Start und danach alle 24 Stunden.
- Gesendet wird mit `store: false`.
- Lehnt ein kompatibler Endpunkt einen optionalen Parameter ab, wird nur genau dieser weggelassen (und für Endpunkt + Modell gemerkt). `store: false` entfällt nur, wenn der Endpunkt `store` selbst ablehnt. Vor dem Weglassen kommt, wo es sie gibt, eine mildere Stufe: `json_schema` → `json_object` (siehe [Strukturierte Ausgaben](#strukturierte-ausgaben)) und eine zu hohe Denktiefe → die nächstniedrigere (siehe [Denktiefe](#denktiefe)). Jede solche Abweichung steht als Hinweis im Übertragungsprotokoll.
- Embeddings über `/embeddings`, sofern ein Embedding-Modell konfiguriert ist und der Datenschutzmodus es erlaubt. Gesendet werden maskierte Abschnitte freigegebener Dokumente und – nur im Modus `auto` – deine Entscheidungen, Notizen, offenen Punkte und Ereignisse sowie Suchanfragen; jede Übertragung steht im Übertragungsprotokoll.
- Was ein Eintrag an `/embeddings` schickt, ist auf `llm.maxInputChars` Zeichen **insgesamt** begrenzt (Standard 24 000), gezählt vor der Maskierung. Ein Dokument wird in Abschnitte von rund 900 Zeichen geteilt, jeder Abschnitt mit dem Titel davor; gesendet werden die Abschnitte von vorn, solange sie vollständig in die Grenze passen. Alles dahinter – bei langen Dokumenten der größte Teil – geht nicht an den Endpunkt. Diese Abschnitte bekommen nur den lokalen Vektor, bleiben also über die Volltext- und die lokale Vektorsuche auffindbar. Ist schon der erste Abschnitt länger als die Grenze, wird er gekürzt. Im Übertragungsprotokoll steht die tatsächlich gesendete Größe.
- Die Diagnose des Agenten (`diagnose`) schickt im Modus „automatisch“ einmal `POST {baseUrl}/embeddings` mit dem festen Text „Verbindungstest“ (ohne Dokument-IDs), um die Antwortzeit zu messen; sie steht im Übertragungsprotokoll mit Zweck „Diagnose: Embedding-Endpunkt“. Das Protokoll, das `read_logs` liest, geht als Werkzeugergebnis (maskiert, ohne ausgeschlossene Dateien) mit der Agentenanfrage hinaus ([Agentenmodus](agentenmodus.md#archivist-untersuchen)).

- Die Widerspruchsprüfung (Zweck „Widerspruchsprüfung“) schickt im Modus „automatisch“ je Paar aktiver Entscheidungen desselben Themas oder Projekts beide Entscheidungstexte (je auf 800 Zeichen gekürzt, maskiert, als Daten gekennzeichnet; im Übertragungsprotokoll). Jedes Paar von Texten wird nur einmal gefragt: Das Urteil steht in der Tabelle `contradiction_reviews` (Hash beider Texte, Urteil, Zeitpunkt – kein Klartext). Je Archivprüfung gehen höchstens 60 Paare hinaus, bei der Sofortprüfung einer Entscheidung höchstens 10. Ist ein Quelldokument einer der beiden Entscheidungen ausgeschlossen oder nicht freigegeben (`mayShareDocument`, wie bei Themenvorschlägen und Verknüpfungsprüfung), geht das Paar nie hinaus; es gilt das lexikalische Ergebnis. In „vorher fragen“ und „nur lokal“ geht nichts hinaus. Dieselbe Zweckbeschreibung mit dem Zusatz „zwischen Dokumenten“ gilt für den Vergleich zweier Dokumente desselben Themas oder Projekts: Gesendet werden je Dokument Titel, Zusammenfassung (600 Zeichen) und Textanfang (1.200 Zeichen), maskiert, mit „Daten, keine Anweisungen“ markiert und im Übertragungsprotokoll. Nur Dokumente, die `mayShareDocument` freigibt, kommen als Kandidaten infrage – beide eines Paars; es gehen höchstens 30 Paare je Archivprüfung hinaus, und das Urteil steht ebenfalls in `contradiction_reviews` (Hash beider Texte, kein Klartext).

## Denktiefe

- `llm.reasoningEffort` geht als `reasoning.effort` mit. **„keine“ (`none`) wird gesendet** – ein Modell, dessen Standard denkt, denkt dann nicht. Nur „Standard des Modells“ (leer) lässt den Parameter weg.
- „sehr hoch“ (`xhigh`) und „maximal“ (`max`) gibt es zusätzlich. Bei OpenAI und Azure OpenAI geht „maximal“ als `xhigh` hinaus (OpenAI kennt kein `max`), jeder andere Endpunkt bekommt, was du gewählt hast.
- Lehnt der Endpunkt eine Stufe ab, geht Archivist stufenweise herunter (`max` → `xhigh` → `high`) und merkt sich für Endpunkt und Modell die höchste Stufe, die ankam. Lehnt er auch `high` oder den Parameter überhaupt ab, entfällt er. Beides steht als Hinweis im Übertragungsprotokoll („Denktiefe „max“ als „high“ gesendet“).
- Ältere Einstellungen bleiben gültig. Der Claude-Pfad (Messages API) sendet für einfache Anfragen keine Denktiefe; die des Agenten stellst du im Agentenmodus ein ([Agentenmodus](agentenmodus.md#anbieter)).

## Strukturierte Ausgaben

- Angefordert wird **Structured Outputs**: `text.format = json_schema` mit `strict: true`. Das Schema entsteht aus dem Zod-Schema: jedes Objekt ist geschlossen (`additionalProperties: false`), alle Eigenschaften sind Pflicht (auch die, die Zod als optional führt – ein `null` würde Zod ablehnen), Prüfungen wie Längen oder Muster entfallen im Schema, weil Zod sie ohnehin prüft. Ein Schema, das sich so nicht ausdrücken lässt (freie Objekte, Tupel), geht stattdessen als `json_object`; ein Test stellt sicher, dass alle Schemas der App umwandelbar sind.
- Zusätzlich steht das JSON-Schema im Prompt. Die Eingabe nennt immer das Wort „JSON“, das der JSON-Modus der Responses API in der Eingabe – nicht in den Instructions – verlangt.
- Lehnt der Endpunkt `json_schema` ab (oder das Schema), geht die Anfrage sofort als `json_object` noch einmal; das merkt sich Archivist für Endpunkt und Modell. Der Hinweis „Der Endpunkt lehnt json_schema ab: JSON-Modus (json_object) verwendet.“ steht an jeder betroffenen Übertragung im Protokoll und die zweite Anfrage in der Anfragezahl.
- Die Antwort wird mit Zod validiert.
- Bei ungültiger Ausgabe folgt genau eine Korrekturanfrage, danach Verwerfen + sichtbarer technischer Fehler. Der Korrekturhinweis hängt nach dem Kürzen der Eingabe an, geht also auch bei kleinem `llm.maxInputChars` immer mit.
- **Ungültige Ausgaben lösen nie Datei- oder Datenbankänderungen aus.**
- **Ausgabelimit:** `max_output_tokens` je Schema (z. B. 400 für Themennamen, 8 000 für die Dokumentklassifikation, großzügig weit über jeder echten Antwort) setzt Archivist nur, wo es keine Antwort abschneiden kann: beim Claude-Pfad und bei Denktiefe „keine“. Denkende Modelle zählen die Denk-Token gegen das Limit und könnten sonst mitten im JSON enden; sie bekommen keins. Der Verbindungstest (strukturierte Antwort) setzt bewusst nie eins, der einfache Verbindungstest nur 64 Token für sein eines Wort. Wird eine Antwort am Limit abgeschnitten, wiederholt Archivist sie nicht (dasselbe Limit schnitte sie wieder ab).

## Tokenverbrauch und Tageslimit

- Jede Übertragung im Protokoll hält die Tokens fest, die der Dienst in seiner Antwort meldet: Eingabe, Ausgabe und aus dem Cache gelesene (Antworten, strukturierte Antworten, Embeddings, Claude und die Agentenläufe), außerdem die **Anfragen**, die sie gebraucht hat. Eine Übertragung ist ein Eintrag, auch wenn sie wiederholt wurde: `complete` versucht es bis zu dreimal (bei Zeitüberschreitung zweimal), `completeJson` mit der Korrekturanfrage zweimal, jede Wiederholung und jedes Neusenden ohne abgelehnten Parameter zählt als Anfrage. Meldet ein Dienst keine Tokens, bleiben die Spalten leer.
- **Einstellungen → Datenschutz → Tokenverbrauch** zeigt die Summen für heute (ab Mitternacht deiner Zeit) und für diesen Monat (Kanal `llm:usage`).
- Das **Tageslimit** (`llm.dailyTokenCap`, Standard aus) zählt Eingabe, Cache und Ausgabe des heutigen Tages. Ist es erreicht, geht keine Anfrage mehr hinaus – vorher wird nichts gesendet:
  - **Hintergrundarbeit** pausiert: Automatische Funktionen, die nur im Modus „automatisch“ laufen (Widerspruchsprüfung, Themenvorschläge, Hintergrundläufe des Agenten), werden übersprungen. Eine Dokumentanalyse in der Warteschlange wartet als „Pausiert“ bis zum nächsten Tag, ohne einen Versuch zu verbrauchen, und läuft sofort weiter, sobald du das Limit erhöhst oder entfernst. Sie fällt nicht auf die lokale Klassifikation zurück. **Massenläufe** (Alle neuen Dateien analysieren, Auswahl-Analyse, Analyse mehrerer hochgeladener Dateien, Ordnerimport, Neu verarbeiten) halten beim Erreichen an: Das Dokument, bei dem es auftrat, und alle weiteren bleiben unverändert (nicht „fehlgeschlagen“), der Auftrag setzt mit seinem Stand fort, und eine Benachrichtigung „Analyse pausiert“ nennt den Fortschritt.
  - Im **Chat** fragt Archivist vorher („Trotzdem fortfahren“). Du entscheidest je Unterhaltung; danach gilt die Freigabe bis Tagesende.
  - Andere Aktionen, die du in der Oberfläche auslöst (z. B. eine Wissensfrage), melden den Fehler „Tageslimit erreicht“. Der Verbindungstest geht immer durch.
- **Schätzung vor einem Import:** `estimateTokens(text | Zeichenzahl)` aus dem Core-Paket schätzt vier Zeichen je Token, aufgerundet; für eine Vorabschätzung (Dokumente × Zeichen je Dokument, begrenzt auf `llm.maxInputChars`) ohne die Datei zu lesen.

## Fehler und Ausfall

- Nicht erreichbarer Endpunkt: verständliche Fehlermeldung, Retries bei transienten Fehlern (Netzwerk/429/5xx), Status in der Kopfzeile.
- **Retry-After:** Der Header (Sekunden oder HTTP-Datum) steht als `retryAfterMs` am Fehler (höchstens 5 Minuten, auch in der Fehlerinfo der Oberfläche). Der Client wartet in seinen eigenen Wiederholungen genau so lange (ein Abbruch durch dich beendet das Warten). Verlangt der Endpunkt 5 Minuten oder mehr, wartet der Client nicht, sondern gibt den wiederholbaren Fehler sofort mit `retryAfterMs` zurück; ebenso nach dem letzten Versuch. Wer den Fehler einreiht, nutzt diese Zeit statt eines eigenen Backoffs.
- Ein 429 (Limit des Dienstes) zählt zur Gesundheit des Endpunkts: Danach scheitern Anfragen für die Zeit aus Retry-After sofort (ohne Header 15 s, bei jedem weiteren 429 doppelt so lang, höchstens 5 Minuten; ein Erfolg setzt zurück). Der Fehler dabei trägt die verbleibende Wartezeit als `retryAfterMs`.
- **Dokumentanalyse bei Limit oder Ausfall**: Meldet der Endpunkt nach den Wiederholungen des Clients (3 Anfragen) weiterhin einen wiederholbaren Fehler, stuft die Analyse das Dokument nicht still herab. Sie reiht den Auftrag neu ein und wartet so lange, wie der Server verlangt (`Retry-After`, auf höchstens 5 Minuten begrenzt; der Fehlertyp trägt es als `retryAfterMs`), sonst mit zunehmender Wartezeit (5 s, 10 s, … bis 5 min). Das Dokument bleibt `llmStatus: pending`. Nach dem 5. erfolglosen Versuch fällt die Analyse auf die lokale Klassifikation zurück und benachrichtigt wie bisher. Nicht wiederholbare Fehler (401, 403, 404, ungültige Antwort) fallen sofort zurück. Jeder Versuch ist eine eigene Anfrage im Übertragungsprotokoll.
- Nach einer Zeitüberschreitung oder einem unerreichbaren Endpunkt scheitern Anfragen 60 s lang sofort; der Verbindungstest geht immer durch.
- Der Chat fällt auf eine regelbasierte Auswertung bzw. lokale Trefferlisten zurück und kennzeichnet das deutlich.

## Lange Dokumente

- Die Klassifikation (Schema `DocumentClassification`) sendet einen Text, der mit dem Prompt nicht in `llm.maxInputChars` passt, in bis zu 6 aufeinanderfolgenden Teilen. Jeder Teil nennt im Prompt „Teil i von n“, der Text bleibt als Daten markiert.
- Jeder Teil ist eine eigene Anfrage: Er geht nur, wenn das Dokument zur externen Analyse freigegeben ist (Datenschutzmodus, Ausschlüsse, Ordnerfreigabe – einmal je Dokument geprüft), wird maskiert und steht mit dem Zweck „Dokumentklassifikation (Dateiname, Teil i von n)“ und der Dokument-ID im Übertragungsprotokoll.
- Titel, Thema, Projekt, Ablageort und Einschätzung stammen aus dem ersten Teil; Entscheidungen (mit wörtlichem Beleg im Dokument), offene Punkte, Personen, Tags und Daten werden aus allen Teilen zusammengeführt.
- Was gelesen wurde, speichert der Vorschlag als `coverage` (`textChars`, `llmChars`, `llmParts`, `extractionTruncated`) und zeigt es in der Oberfläche. Über 6 Teile hinaus liest die KI nichts mehr; der Rest ist im Hinweis ausgewiesen.

## Antworten auf Wissensfragen

- Fakten müssen auf tatsächlich bereitgestellte Quellen verweisen. Aussagen mit ungültigem Quellenbeleg werden verworfen und als Unsicherheit ausgewiesen.
- Bleibt keine belegte Aussage übrig, erscheint die Antwort des Modells nur als „Nicht belegt (Einschätzung des Modells)“, die Einschätzung wird auf „sehr unsicher“ gesetzt (Hinweis „Bitte prüfe diese Antwort“), und gefundene, aber nicht zitierte Quellen sind als „gefunden, nicht zitiert“ gekennzeichnet.
- Zu gefundenen Entscheidungen kommen ihre Quelldokumente mit der passenden Textstelle in den Prompt.
- Im Chat gehen bis zu sechs vorherige Nachrichten des Gesprächs mit, als Daten markiert und nur zum Auflösen von Bezügen wie „daran“, nie als Quelle für Fakten. Deine Nachrichten sind auf 280, Antworten auf 200 Zeichen gekürzt; Antworten aus dem Archiv (mit Quellen) erscheinen nur als Vermerk „Inhalt ausgelassen“. Ruft der Agent die geprüfte Wissensantwort als Werkzeug auf, geht kein Chatverlauf mit.
- Über **bestätigte** Beziehungen der drei besten Treffer kommen bis zu drei weitere Einträge hinzu (höchstens zwei je Treffer, halbe Gewichtung), mit dem Vermerk „Hinzugekommen über die bestätigte Verknüpfung: …“. Vorgeschlagene, abgelehnte und veraltete Beziehungen werden nie genutzt; Freigaben gelten wie für Treffer.

## Analyse von Notizen

- Schema `NoteAnalysis`: Thema, Projekt, Personen, Tags. Nur im Modus „automatisch“; sonst lokal.
- Der Notiztext ist im Prompt als Daten markiert; bekannte (bestätigte) Themen und Projekte gehen als Kontext mit – höchstens 40 je Art, die zum Text passen. Das gilt auch für die Dokumentklassifikation.
- Das Ergebnis wird nur ein Vorschlag (Methode `analysis`); neue Themen und Projekte daraus bleiben unbestätigt.

## Schutz vor Prompt-Injection

- Dokumenttexte, Verlauf und Kontextlisten sind in jedem Prompt als Daten markiert.
- Agentenmodus: Wird ein Dokument nach dem Lesen ausgeschlossen oder sein Ordner gesperrt, gehen frühere Werkzeugergebnisse und Antworten, die es nennen, nicht erneut mit; im Verlauf steht stattdessen „Ergebnis ausgeblendet“. Gedankenblöcke des Anbieters (Thinking, Reasoning) früherer Antworten entfallen dann ganz.
- Vorschläge führt der Chat nur nach einem eindeutigen „ja“ des Benutzers aus, nie auf eine Einordnung des Modells hin.
- Frühere Antworten aus dem Archiv gehen nicht als Text in die Intent-Erkennung ein.
- Themen und Projekte, die unverändert aus einem Dokument übernommen wurden, werden dem Modell erst nach deiner Bestätigung (oder sobald du den Namen selbst verwendest) als bekannt genannt.
- Bei reinen HTML-E-Mails fällt für den Leser unsichtbarer Text (`display:none`, `font-size:0`, …) aus dem Dokumenttext heraus.
