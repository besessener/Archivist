# LLM-Schnittstelle

Wie Archivist mit dem LLM-Endpunkt spricht. Einrichtung: [LLM-Anbieter verbinden](../how-to/llm-anbieter-verbinden.md). Für den Agentenmodus mit Werkzeugen siehe [Agentenmodus](agentenmodus.md#anbieter).

## Einstellungen

Konfigurierbar (nichts davon ist im Code verdrahtet):

| Einstellung | Schlüssel in `settings.json` |
| --- | --- |
| Base URL | `llm.baseUrl` |
| API-Key | nicht in `settings.json`, siehe [Geheimnisse](aktionsstufen.md#geheimnisse) |
| Modellname | `llm.model` |
| Reasoning effort (optional) | `llm.reasoningEffort` |
| Timeout | `llm.timeoutMs` |
| maximale Eingabegröße | `llm.maxInputChars` (zu lange Eingaben werden in der Mitte gekürzt, Anfang und Ende bleiben; die Klassifikation eines Dokuments teilt lange Texte stattdessen in Teile, siehe [Lange Dokumente](#lange-dokumente)) |
| Embedding-Modell (optional) | `llm.embeddingModel` |

## Anfragen

- Verwendet wird die OpenAI-kompatible **Responses API**: `POST {baseUrl}/responses`, z. B. mit `https://<resource>.openai.azure.com/openai/v1`.
- Authentifizierung wird als `Authorization: Bearer` **und** `api-key` gesendet.
- Gesendet wird mit `store: false`.
- Lehnt ein kompatibler Endpunkt einen optionalen Parameter ab, wird nur genau dieser weggelassen (und für Endpunkt + Modell gemerkt). `store: false` entfällt nur, wenn der Endpunkt `store` selbst ablehnt.
- Embeddings über `/embeddings`, sofern ein Embedding-Modell konfiguriert ist und der Datenschutzmodus es erlaubt. Gesendet werden maskierte Abschnitte freigegebener Dokumente und – nur im Modus `auto` – deine Entscheidungen, Notizen, offenen Punkte und Ereignisse sowie Suchanfragen; jede Übertragung steht im Übertragungsprotokoll.

- Die Diagnose des Agenten (`diagnose`) schickt im Modus „automatisch“ einmal `POST {baseUrl}/embeddings` mit dem festen Text „Verbindungstest“ (ohne Dokument-IDs), um die Antwortzeit zu messen; sie steht im Übertragungsprotokoll mit Zweck „Diagnose: Embedding-Endpunkt“. Das Protokoll, das `read_logs` liest, geht als Werkzeugergebnis (maskiert, ohne ausgeschlossene Dateien) mit der Agentenanfrage hinaus ([Agentenmodus](agentenmodus.md#archivist-untersuchen)).

- Die Widerspruchsprüfung (Zweck „Widerspruchsprüfung“) schickt im Modus „automatisch“ je Paar aktiver Entscheidungen desselben Themas oder Projekts beide Entscheidungstexte (je auf 800 Zeichen gekürzt, maskiert, als Daten gekennzeichnet; im Übertragungsprotokoll). Jedes Paar von Texten wird nur einmal gefragt: Das Urteil steht in der Tabelle `contradiction_reviews` (Hash beider Texte, Urteil, Zeitpunkt – kein Klartext). Je Archivprüfung gehen höchstens 60 Paare hinaus, bei der Sofortprüfung einer Entscheidung höchstens 10. Ist ein Quelldokument einer der beiden Entscheidungen ausgeschlossen oder nicht freigegeben (`mayShareDocument`, wie bei Themenvorschlägen und Verknüpfungsprüfung), geht das Paar nie hinaus; es gilt das lexikalische Ergebnis. In „vorher fragen“ und „nur lokal“ geht nichts hinaus.

## Strukturierte Ausgaben

- Das JSON-Schema wird aus dem Zod-Schema erzeugt und im Prompt mitgegeben; angefordert wird `text.format = json_object`. Die Eingabe nennt dafür immer das Wort „JSON“, das die Responses API in der Eingabe – nicht in den Instructions – verlangt.
- Die Antwort wird mit Zod validiert.
- Bei ungültiger Ausgabe folgt genau eine Korrekturanfrage, danach Verwerfen + sichtbarer technischer Fehler.
- **Ungültige Ausgaben lösen nie Datei- oder Datenbankänderungen aus.**

## Fehler und Ausfall

- Nicht erreichbarer Endpunkt: verständliche Fehlermeldung, Retries bei transienten Fehlern (Netzwerk/429/5xx), Status in der Kopfzeile.
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
