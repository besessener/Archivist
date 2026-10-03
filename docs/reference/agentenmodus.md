# Agentenmodus

Technische Referenz zum Agentenmodus (Epic #294). Das Konzept dahinter erklärt [Archivist als Agent](../explanation/agent.md).

Der Agentenmodus ist aktiv, wenn ein LLM mit nativem Tool-Calling konfiguriert ist. Ohne LLM, im Modus `local_only` oder bei einem Endpunkt ohne natives Tool-Calling gilt die regelbasierte Auswertung.

## Kern

Code: `packages/core/src/agent/`.

- Anbieterneutrale Schleife (`runner.ts`) mit Werkzeug-Register: Name, Beschreibung, Zod-Schema, Risikostufe `read`/`write`/`critical`, Ausführung über dieselben Service-Funktionen wie die Oberfläche.
- Ungültige Argumente gehen als Fehler-Ergebnis an das Modell zurück.
- Lesende Aufrufe einer Runde laufen parallel.
- Rückfragen (`ask_user`) sind ein eigener Ausgang; die Antwort setzt den Lauf mit vollem Kontext fort.
- **Grenzen** statt fester Schrittzahl: Token-Budget, Notbremse für Runden, Zeitlimit, Schleifenerkennung und „Stopp“. An einer Grenze fasst der Agent zusammen, was erledigt ist und was fehlt. Einstellbar unter Einstellungen → Agent → Erweitert (`chatLimits`, `backgroundLimits`). Für Hintergrundaufgaben gibt es dort außerdem eigene Grenzen je Auslöser (`backgroundKindLimits`: Einsortieren, Archivprüfung, Verknüpfungen, geplante Abläufe); leere Felder gelten wie `backgroundLimits`.

## Anbieter

| Anbieter | Schnittstelle | SDK |
| --- | --- | --- |
| Claude | Anthropic Messages API | `@anthropic-ai/sdk`; für Microsoft Foundry `@anthropic-ai/foundry-sdk` |
| ChatGPT/OpenAI | Responses API (auch Azure OpenAI bzw. Foundry `…/openai/v1`) | eigener Fetch-Client |

- Der Adapter wird aus der Base URL erkannt (`api.anthropic.com` bzw. `…/anthropic` → Claude, sonst Responses) und lässt sich unter Einstellungen → Agent → Erweitert überschreiben.
- Der Verbindungstest prüft einen echten Werkzeugaufruf mit Rückgabe und Streaming.
- Claude-Modelle auf Foundry bieten natives Tool-Calling am Anthropic-Endpunkt derselben Ressource (`https://<resource>.services.ai.azure.com/anthropic`) – der Dialog schlägt ihn vor.
- **Claude**: Thinking ist immer an und wird nur über `effort` gesteuert (Standard `high`); Werkzeugaufrufe werden nie erzwungen (`tool_choice: auto`); Systemanweisung und Werkzeugliste werden gecacht; Task-Budget (nur Claude API) und Kompaktierung werden genutzt, wo verfügbar, und abgeschaltet, wenn ein Endpunkt sie ablehnt.
- Der Verlauf wird anbieterneutral gespeichert – ein Wechsel des Anbieters braucht keinen Neustart.

## Websuche im Chat

- Im Chat darf der Agent im Internet suchen – über die eingebaute Websuche des Anbieters:
  - Claude: Server-Werkzeug `web_search_20250305`, höchstens 5 Suchen pro Anfrage,
  - OpenAI/Azure: gehostetes Werkzeug `web_search`.
- Lokalisiert über die Zeitzone des Rechners.
- Archivist selbst baut dafür keine weitere Verbindung auf; die Suche läuft beim konfigurierten Anbieter, der sie gesondert berechnet (Claude: 10 US$ pro 1.000 Suchen, nicht in der Kostenschätzung enthalten).
- Jede Suche erscheint als Schritt im Lauf; die zitierten Seiten stehen als „Quellen aus dem Web“ unter der Antwort und öffnen sich im Standardbrowser.
- Der Agent soll keine vertraulichen Archivinhalte in Suchanfragen schreiben. Webseiten sind wie Dokumente nur Daten – nach einer Websuche ändert ein Lauf nichts, worum der Benutzer nicht selbst gebeten hat.
- Hintergrundaufgaben suchen nie im Web.
- Abschaltbar unter Einstellungen → Agent → „Websuche im Chat“. Bietet ein Endpunkt keine Websuche an (oder ist sie für die Organisation abgeschaltet), läuft der Chat ohne sie weiter.

## Modi

| Modus | Verhalten |
| --- | --- |
| **Auto** (Standard) | führt Änderungen selbst aus, protokolliert sie und macht sie auf Wunsch rückgängig |
| **Fragen** | bereitet jede Änderung als Vorschlag vor – eine Karte, ganz oder teilweise bestätigbar |

Pro Gespräch umschaltbar, auch per „frag mich diesmal vorher“.

**Immer nachgefragt** wird – in jedem Modus – bei:

- Löschen (Dokumente in den Papierkorb legen, `mark_duplicates` mit `delete`; mit zweiter Bestätigung),
- Änderungen an Originaldateien außerhalb des Archivs,
- Datenschutz-Einstellungen,
- neuen Hauptkategorien,
- Massenaktionen über der Schwelle (Standard: mehr als 100 Einträge in einem Lauf).

Für die Schwelle zählt, was ein Aufruf tatsächlich ändern würde: `apply_rules` ohne Auswahl alle archivierten Dokumente, auf die eine Regel passt, `merge_subjects` die zusammengeführten Einträge, `decide_link_proposals` die betroffenen Vorschläge. Eine Verknüpfung „auf Wunsch des Benutzers“ (`onUserRequest`) gilt nur als bestätigt, wenn deine eigene Nachricht eine Änderung verlangt oder du auf die Rückfrage „ja“ gesagt hast – sonst bleibt sie ein Vorschlag.

## Agentenläufe

- Jeder Lauf hat eine Lauf-ID mit Auslöser, Anbieter und Modell, Werkzeugaufrufen (gekürzte Ergebnisse), Tokens und geschätzten Kosten, Dauer und Ergebnis.
- Jede Änderung trägt die Lauf-ID (Änderungsprotokoll, Beziehungen mit Herkunft `agent`).
- „Lauf rückgängig“ setzt alle Änderungen in umgekehrter Reihenfolge mit Konfliktprüfung zurück, einzelne Schritte ebenso.
- Ansicht unter Einstellungen → Agent.

## Große Dateiaktionen

- Verschieben, Umbenennen und Ordner-Umlegen von mehr als 50 Dateien laufen als eigener Auftrag (`agent.files`), in Blöcken zu 25.
- Der Auftrag trägt Lauf-ID und Schritt: Jede Änderung steht unter dem Lauf; „Lauf rückgängig“ und Rückgängig pro Schritt decken ihn ab.
- Der Schritt zeigt den Fortschritt live im Chat; die Auftragsliste verlinkt den Lauf.
- „Stopp“ bricht zwischen zwei Blöcken ab – Erledigtes bleibt und bleibt rückgängig machbar. Beim Beenden wird der Auftrag unterbrochen und nach dem nächsten Start an derselben Stelle fortgesetzt.
- Modus „Fragen“ und die Schwelle für Massenaktionen gelten unverändert (vor dem Auftrag).
- Dasselbe gilt für `archive_inbox`: Dokumente aus dem Eingang werden in Blöcken archiviert, ab der Schwelle als eigener Auftrag.
- Ein Hintergrund-Lauf ist selbst ein Auftrag und arbeitet deshalb ohne zweiten Auftrag, mit Fortschritt im eigenen.

## Dateien und Ablage

- `move_documents`, `rename_documents` (einzeln oder nach Schema, erst Vorschau), `create_folder`, `rename_folder`, `remove_empty_folders`, `archive_inbox`, `exclude_from_scan`.
- `propose_structure`: eine neue Ordnerstruktur als Plan. Er erscheint immer als Vorschlagskarte mit einem Punkt je Gruppe und lässt sich ganz oder teilweise bestätigen.
- Rückgängig gibt es für jede Änderung – auch für angelegte Ordner (solange nichts darin liegt), entfernte leere Ordner und Scan-Ausschlüsse.
- `exclude_from_scan` nimmt nur absolute Pfade innerhalb der freigegebenen Scan-Ordner an.
- `reanalyze`: Dokumente im Eingang werden neu analysiert; archivierte und nur indexierte werden in **einem** Auftrag neu gelesen (Text, OCR, Suchindex) – Titel, Typ, Zuordnungen und Verknüpfungen bleiben.
- Umbenennen nach Schema steht mit derselben Funktion in der Dokumentliste (Mehrfachauswahl → „Umbenennen“).

## Lesen

- `find_documents` filtert nach Endung, Name, Ordner, Thema, Projekt, Typ, Person, Tag, Dokument- und Archivierungsdatum, Größe und Status, sortiert und seitenweise, mit Gesamtzahl und Ergebnismenge `S…` (`within` grenzt eine frühere Menge ein). Ergebnismengen beliebiger Größe werden vollständig aufgelöst.
- `related` liefert dieselbe Liste wie „Verwandte Einträge“ in der Oberfläche (direkte Beziehungen und gemeinsame Projekte, Vorgänge, Themen, Personen, Tags, nach Stärke, seitenweise); `depth: 2` nennt auch die Nachbarn der Nachbarn.
- Einträge, die nur aus nicht freigegebenen Dokumenten stammen, nennt `list_entries` ohne Inhalt.

## Wissen erfassen

- Entscheidungen, Notizen, offene Punkte, Erinnerungen und Ereignisse erfasst ein Modul (`services/capture.ts`): Pflichtangaben und Rückfragen, Dubletten-Prüfung, Personen-Auflösung, Ersetzen und Widerspruchsprüfung.
- Die Erfassungswerkzeuge des Agenten und der regelbasierte Chat rufen dasselbe Modul auf. Rückfragen stellt der Agent über `ask_user`, der regelbasierte Chat über seine Rückfrage im Gespräch.
- `chat.ts` enthält nur noch den Gesprächsablauf und den regelbasierten Rückfall (Absicht-Klassifikation und `dispatch()`).
- Ist beim Ersetzen nicht eindeutig, welche ältere Entscheidung gemeint ist, nennt `record_decision` die Kandidaten mit ihren K-IDs; nach der Rückfrage legt `supersede_decision` die Vorschlagskarte an. Als überholt markiert wird erst nach deiner Bestätigung.
- `set_metadata` ändert bei Entscheidungen, offenen Punkten und Ereignissen auch Titel, Personen (Beteiligte bzw. Verantwortliche) und Datum (Entscheidungsdatum, Fälligkeit, Ereignisdatum).
- Datumsangaben ohne Jahr: „31.10.“ ist bei einer Entscheidung der letzte 31. Oktober, bei einer Erinnerung oder Fälligkeit der nächste.

## Verknüpfungsmethoden

Die festen Methoden aus Epic #269 als eigene Werkzeuge, mit denselben Service-Funktionen wie die Oberfläche (`services/link-methods.ts`). Alle schlagen nur vor; abgelehnte Paare kommen nie wieder.

| Werkzeug | Methode |
| --- | --- |
| `suggest_links` | ähnliche Einträge (Kosinus der gespeicherten Abschnittsvektoren; lokale Hash-Vektoren mit höherer Schwelle als echte Embeddings) und genannte Themen/Projekte, bis zu 3 je Eintrag |
| `find_unlinked_entries` | Einträge ohne bestätigte oder vorgeschlagene Beziehung (ein Ordner allein zählt nicht), seitenweise, rein per SQL |
| `find_topic_clusters`, `propose_topic` | Gruppen ähnlicher Einträge ohne Thema als Hinweis „Neues Thema ‚…‘ anlegen?“; „Ja“ legt an und ordnet zu (rückgängig machbar), „Nein“ wird gemerkt |
| `backfill_links` | rückwirkender Lauf über das Archiv mit allen Methoden (ähnlich, gleicher Tag + Person, gleiches Quelldokument, Analyse von Notizen); merkt sich die Stelle |
| `linkage_report` | Verknüpfungsgrad: Anteil verwaister Einträge, offene Vorschläge, Bestätigungsquote je Methode, Verlauf der Archivprüfungen und die aus Ablehnungen gelernten Schwellen (nur lesen) |
| `reset_learned_thresholds` | setzt die gelernten Schwellen zurück; nicht rückgängig machbar, fragt deshalb immer (kritisch) |

Weitere Werkzeuge für die Verknüpfungen:

| Werkzeug | Zweck |
| --- | --- |
| `set_metadata` | `topic`/`project` ersetzen das Hauptthema bzw. -projekt (Ablage). `addTopics`/`addProjects` ergänzen weitere – wer noch keins hat, bekommt es als Hauptthema –, `removeTopics`/`removeProjects` entfernen weitere; `case` ordnet einem vorhandenen Vorgang zu; `addTags` gilt für alle Arten von Einträgen. Ergänzungen sind wie die Sammelzuordnung ein Rückgängig-Schritt |
| `link` | auch `subtopic_of`: ein Thema oder Projekt unter ein anderes einordnen (keine Kreise) |
| `update_note` | Titel und Text einer Notiz ändern (nur auf Wunsch); `[[Name]]` verlinkt, unbekannte Namen meldet das Werkzeug zum Anlegen |
| `case_overview` | ein Vorgang mit Status, offenen Punkten und Verlauf (nur lesen; Dokumentnamen nur mit Freigabe) |
| `list_subjects` | zeigt bei Unterthemen das Oberthema |

- Dieselben Vorschläge zeigen die Erfassungswerkzeuge nach dem Speichern und die Wissensseite unter „Vorschläge zum Verknüpfen“.
- Der Hintergrund-Lauf „Verknüpfungen“ arbeitet mit diesen Werkzeugen.
- Ohne Agent startet der rückwirkende Lauf einmal nach dem Update und unter Einstellungen → Agent → Agentenläufe auf Knopfdruck (lokal, ein gebündelter Hinweis am Ende).

## Sicherheit

- Dokumentinhalte gehen nur als markierte Daten an das Modell, nie als Anweisungen. Enthält ein Dokument eine Aufforderung an den Agenten, ändert der Lauf nichts ohne eigene Bitte des Benutzers (im Hintergrund nur als Vorschlag).
- Jedes Werkzeugergebnis läuft durch den Datenschutzfilter: Nicht freigegebene Dokumente erscheinen nur mit Endung, Ordner und Status.
- Geheimnisse werden vor jeder Übertragung maskiert – in deiner Nachricht, in Werkzeugergebnissen und in der Systemanweisung (Gelerntes, Profil); welche Dokumente an das LLM gingen und wie viele Stellen maskiert wurden, steht im Übertragungsprotokoll.
- Wird ein Dokument nach dem Lesen ausgeschlossen oder sein Ordner gesperrt, gehen frühere Werkzeugergebnisse und Antworten des Gesprächs, die es nennen, nicht erneut an das Modell (#202); Gedankenblöcke des Anbieters entfallen dann.
- Alle Datei-Werkzeuge bleiben im Archiv (Exporte im Datenordner); Path-Traversal und Symlinks, die hinausführen, werden abgelehnt.

## Verbrauch

- Tokens (Eingabe, Ausgabe, Cache) pro Anfrage und Lauf.
- Kosten aus einer pflegbaren Preistabelle – nur zur Information, es gibt **keine Kostenobergrenze**.
- Übersicht pro Tag und Monat, getrennt nach Chat und Hintergrund.

## Hintergrund

Code: `background-tasks.ts` (Aufgaben, Benachrichtigung), `background-schedule.ts` (Zeitgeber), `service.ts` (`runBackground`).

| Auslöser | Wann | Aufgabe |
| --- | --- | --- |
| `inbox` | 20 Sekunden nach der letzten Analyse einer neuen Datei – nach Scan **und** nach Import (`document.analyze`, `scanner.analyze`); mehrere Dateien ergeben einen Lauf | Eingang einsortieren |
| `archive_check` | Nachtlauf, wenn eingeschaltet | Befunde der Archivprüfung auswerten, eindeutig Falsches aufräumen |
| `links` | Nachtlauf, wenn eingeschaltet | Verknüpfungen pflegen (bleiben Vorschläge) |
| `workflow:<id>` | Nachtlauf am eingestellten Wochentag | eigenen Ablauf mit `run_workflow` ausführen |

- Der Nachtlauf (`nightlyHour`) ist der einzige Zeitplan: Archivprüfung, Verknüpfungen **und** Abläufe mit Wochentag starten nur zu dieser Stunde. Ohne Uhrzeit läuft nachts nichts; die Einstellungen und der Ablauf-Dialog sagen das ausdrücklich. Einmal pro Tag.
- Alles sind Jobs (`agent.background`, höchstens 2 Versuche) mit eigenem Budget je Auslöser, abbrechbar. Ohne Rückfragen: Bei Unsicherheit bleibt etwas im Eingang oder wird ein Vorschlag.
- Dieselben Modi, Ausnahmen und der Datenschutz wie im Chat. Im Modus „Fragen“ wird jede Änderung ein Vorschlag.
- **Eingang einsortieren:** Zuerst wendet der Lauf gelernte Regeln an (`apply_rules`, `preview=false`). Trifft eine Regel mit Ordner ein Eingangsdokument, wird es als Kopie dorthin archiviert (Thema, Projekt und Schlagwörter der Regel inklusive); eine neue Hauptkategorie bleibt dem Benutzer vorbehalten. Für den Rest gelten der Vorschlag der Analyse (`document_details`) und ähnliche frühere Ablagen (`similar_filings`, nur freigegebene Dokumente); eindeutige Fälle archiviert der Lauf, unsichere bleiben im Eingang.
- **Nichts doppelt bezahlen:** Ein Eingangsdokument gilt erst als gesehen, wenn ein Lauf darüber entschieden hat (Status `done`) oder es archiviert wurde. Wird ein Lauf unterbrochen (Neustart, Abbruch, Fehler, Grenze), nimmt der nächste Versuch nur noch die unerledigten Dokumente. Der Job merkt sich die Lauf-ID als Checkpoint; ein fortgesetzter Versuch (auch Archivprüfung, Verknüpfungen, Ablauf) bekommt die schon erledigten Schritte des unterbrochenen Laufs genannt und wiederholt sie nicht.
- **Benachrichtigung:** Je Lauf eine gebündelte Meldung mit Zusammenfassung, den Änderungen und wartenden Vorschlägen. Aktionen: „Lauf ansehen“ und – wenn der Lauf etwas geändert hat – „Rückgängig“ (`undo_run`; macht den ganzen Lauf über `agent:undoRun` rückgängig, wie in der Laufansicht, und erledigt die Meldung).
- Dazu ohne LLM: Fristen-Wächter und Wochenrückblick.

## Gedächtnis

- Gespeichert werden Regeln, eigene Abläufe, Korrekturen, Vorlieben und Wissen über den Benutzer; sie werden jedem Lauf mitgegeben (Fakten und Vorlieben als eigene Abschnitte der Systemanweisung).
- Gespeichert wird nur auf ausdrücklichen Wunsch oder nach Rückfrage, nie aus Dokumenten. Ausdrücklich heißt: „merk dir …“, „speichere …“, „ab jetzt …“, „künftig …“, „Regel: …“ oder „… immer nach/in/unter …“ mit einem Ablage-Verb (ein bloßes „immer“ genügt nicht, Fragen nie) – oder ein „Ja“ auf eine Rückfrage des Agenten.
- **Regeln und Abläufe brauchen eine Bestätigung des Wortlauts:** `remember` (und `update_memory` mit neuer Regel bzw. neuen Schritten) wird vom Gate abgewiesen, solange der Benutzer nicht auf eine Rückfrage `ask_user` mit dem genauen Wortlaut „Ja“ gesagt hat (`needsConfirmedText`). Vorschläge aus Korrekturen sind bereits Vorschlagskarten. Im Hintergrund kann niemand antworten; dort wird nichts gelernt.
- **Widersprüche beim Speichern:** Überschneiden sich die Bedingungen einer neuen Regel mit einer vorhandenen (nicht nur bei gleicher Bedingung) und nennen sie einen anderen Ordner oder ein anderes Thema, speichert `remember` nicht, sondern meldet die Regel; der Agent fragt, welche gelten soll. Beim Anwenden meldet `apply_rules` unauflösbare Widersprüche weiterhin je Dokument.
- **`run_workflow`** startet einen gelernten Ablauf per Name oder ID: `workflow` und `parameters` (z. B. `{"jahr":"2025"}`). Das Werkzeug prüft die Parameter (fehlende nennt es, im Chat fragt der Agent nach), zählt den Lauf und liefert die Schritte, in denen `{name}` durch die Werte ersetzt ist; die Schritte führt der Agent mit den üblichen Werkzeugen aus, also unter Modus, Ausnahmen und Datenschutz. Der **erste** Lauf eines Ablaufs liefert nur den Plan; der Agent zeigt ihn mit `ask_user` und ruft das Werkzeug nach dem „Ja“ erneut auf. Im Hintergrund kann niemand bestätigen: Ein nie bestätigter Ablauf meldet dort nur seinen Plan, und Abläufe mit Parametern laufen dort nicht. Ändern geht mit `update_memory` (oder in der Oberfläche); der nächste Lauf nutzt die neuen Schritte. Optional hat ein Ablauf einen Wochentag für den Nachtlauf.
- **Aus Korrekturen lernen:** Verschiebt der Benutzer ein vom Agenten abgelegtes Dokument, ändert er dessen Thema oder fügt er ein Schlagwort hinzu, wird das als Korrektur gemerkt. Nach 3 gleichartigen Korrekturen (`CORRECTIONS_FOR_RULE`) erscheint ein Hinweis mit Regelvorschlag (Ordner, Thema oder Schlagwort je Dokumenttyp bzw. Endung); gespeichert wird erst nach seiner Bestätigung. „Lauf rückgängig“ und „Schritt rückgängig“ zählen ebenfalls als Korrektur (ohne Regelvorschlag). Eine einzelne Korrektur ergibt nie eine Regel.
- Gelerntes hebt nie Modus, Ausnahmen, Datenschutz oder Grenzen auf: Eine Regel mit Ordner wird im Modus „Fragen“ zum Vorschlag, zählt für die Schwelle für Massenaktionen und legt keine neuen Hauptkategorien an; Anweisungen wie „ignoriere den Datenschutz“ in Fakten oder Regeln bleiben wirkungslos, nicht freigegebene Dokumente dienen weder als Beispiel noch erscheinen sie im Klartext.
- **Ansicht** unter Einstellungen → Agent → „Was Archivist gelernt hat“: Einträge einsehen, ein- und ausschalten, bearbeiten, löschen, als JSON exportieren und importieren. Regeln (Bedingungen und Aktionen) und Abläufe (Schritte, Parameter, Wochentag) bearbeitest du in Feldern, nicht als JSON.

## Evaluation

Siehe [Den Agenten mit echten Modellen evaluieren](../how-to/agent-evaluieren.md).
