# Agentenmodus

Technische Referenz zum Agentenmodus (Epic #294). Das Konzept dahinter erklärt [Archivist als Agent](../explanation/agent.md).

Der Agentenmodus ist aktiv, wenn ein LLM mit nativem Tool-Calling konfiguriert ist. Ohne LLM, im Modus `local_only` oder bei einem Endpunkt ohne natives Tool-Calling gilt die regelbasierte Auswertung.

## Kern

Code: `packages/core/src/agent/`.

- Anbieterneutrale Schleife (`runner.ts`) mit Werkzeug-Register: Name, Beschreibung, Zod-Schema, Risikostufe `read`/`write`/`critical`, Ausführung über dieselben Service-Funktionen wie die Oberfläche.
- Ungültige Argumente gehen als Fehler-Ergebnis an das Modell zurück.
- Lesende Aufrufe einer Runde laufen parallel.
- Rückfragen (`ask_user`) sind ein eigener Ausgang; die Antwort setzt den Lauf mit vollem Kontext fort.
- **Grenzen** statt fester Schrittzahl: Token-Budget, Notbremse für Runden, Zeitlimit, Schleifenerkennung und „Stopp“. An einer Grenze fasst der Agent zusammen, was erledigt ist und was fehlt. Einstellbar unter Einstellungen → Agent → Erweitert (`chatLimits`, `backgroundLimits`).

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

## Fristen und Ablaufdaten

- `find_deadlines` erkennt Fristen und Ablaufdaten (Kündigung, Garantie, Ausweis, Versicherung, TÜV/HU, Widerspruch, Ablauf, Fälligkeit) deterministisch mit Fundstelle und Rechenweg. Ohne Angabe prüft es alle archivierten Dokumente: die neuesten 1000, vorbeigegangene Fristen ausgelassen, höchstens 60 Fristen je Aufruf; der Rest wird gezählt.
- Je Frist (nicht je Dokument) steht dabei, ob schon eine Erinnerung oder ein offener Punkt besteht. Eine Erinnerung gilt für die Frist, wenn sie zum Dokument gehört und mit ihr angelegt wurde (Titel „Kündigungsfrist 30.09.2026: …“) oder am Tag der Frist liegt; ein offener Punkt, wenn das Dokument seine Quelle ist und er am Tag der Frist fällig ist.
- Nicht zur Übertragung freigegebene Dokumente werden nicht ausgewertet: keine Titel, Daten oder Fundstellen, nur Anzahl und Verweise („übersprungen“).
- `create_reminder` nimmt für eine gefundene Frist `deadline` (Art und Datum) und `target` (das Dokument). Ohne `remindAt` liegt die Erinnerung so viele Tage vor der Frist, wie der Vorlauf des Fristen-Wächters (Einstellungen → Agent) angibt, frühestens heute. Gibt es für dieselbe Frist schon eine Erinnerung oder einen offenen Punkt, wird nichts angelegt und das gemeldet; eine schon vorbeigegangene Frist lehnt das Werkzeug ab. Zwei Fristen in einem Dokument bekommen je eine eigene Erinnerung.
- Der Agent legt für eine Frist ohne Erinnerung eine an, wenn du Fristen im Blick behalten willst.

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

- Neue Dateien nach Scan bzw. Analyse einsortieren.
- Agentische Archivprüfung.
- Verknüpfungsvorschläge (bleiben Vorschläge).
- Geplante eigene Abläufe.

Alles als Jobs mit eigenem Budget, abbrechbar, je Lauf eine gebündelte Benachrichtigung. Dazu ohne LLM: Fristen-Wächter und Wochenrückblick.

**Fristen-Wächter** (ohne LLM, einmal pro Tag, eine gebündelte Benachrichtigung):

- Er meldet offene Punkte und ausstehende Erinnerungen bis zum Vorlauf (Standard 14 Tage), auch überfällige, sowie Fristen aus freigegebenen archivierten Dokumenten, für die weder Erinnerung noch offener Punkt besteht. Vorbeigegangene Dokumentfristen meldet er nicht.
- Die Benachrichtigung hat bis zu drei Knöpfe zu den betroffenen Seiten (Dokument oder „Offene Punkte“).
- Ein gemeldeter Eintrag kommt erst wieder, wenn er in zwei Tagen fällig oder überfällig ist. Gemerkte Einträge, die nicht mehr anstehen, werden vergessen.

**Wochenrückblick** (ohne LLM, am eingestellten Wochentag, in einem eigenen Gespräch):

- Neu archivierte Dokumente, Entscheidungen, offene Punkte (erledigt, neu, offen), anstehende Fristen der nächsten 14 Tage einschließlich Dokumentfristen, offene Vorschläge und Hinweise sowie die Hintergrundläufe.
- Einträge sind mit der Seite in der App verlinkt (`[Titel](/documents/?id=…)`, `/decisions/?id=…`, `/open-items/`). Titel nicht freigegebener Dokumente fehlen, sie werden nur gezählt.
- Was schon der letzte Rückblick nannte (offene Punkte, Fristen, Vorschläge), wird nur gezählt: „Weiterhin offen/anstehend seit letzter Woche: N“.


## Gedächtnis

- Gespeichert werden Regeln, eigene Abläufe, Korrekturen, Vorlieben und Wissen über den Benutzer; sie werden jedem Lauf mitgegeben.
- Gespeichert wird nur auf ausdrücklichen Wunsch oder nach Rückfrage, nie aus Dokumenten.
- Nach mehreren gleichartigen Korrekturen schlägt Archivist eine Regel vor.
- Alles ist unter Einstellungen → Agent einsehbar, abschaltbar und löschbar.
- Gelerntes hebt nie Modus, Ausnahmen, Datenschutz oder Grenzen auf.

## Evaluation

Siehe [Den Agenten mit echten Modellen evaluieren](../how-to/agent-evaluieren.md).
