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

- endgültigem Löschen,
- Änderungen an Originaldateien außerhalb des Archivs,
- Datenschutz-Einstellungen,
- neuen Hauptkategorien,
- Massenaktionen über der Schwelle (Standard: mehr als 100 Einträge in einem Lauf).

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
- Ein Hintergrund-Lauf ist selbst ein Auftrag und arbeitet deshalb ohne zweiten Auftrag, mit Fortschritt im eigenen.

## Wissen erfassen

- Entscheidungen, Notizen, offene Punkte, Erinnerungen und Ereignisse erfasst ein Modul (`services/capture.ts`): Pflichtangaben und Rückfragen, Dubletten-Prüfung, Personen-Auflösung, Ersetzen und Widerspruchsprüfung.
- Die Erfassungswerkzeuge des Agenten und der regelbasierte Chat rufen dasselbe Modul auf. Rückfragen stellt der Agent über `ask_user`, der regelbasierte Chat über seine Rückfrage im Gespräch.
- `chat.ts` enthält nur noch den Gesprächsablauf und den regelbasierten Rückfall (Absicht-Klassifikation und `dispatch()`).

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
- Geheimnisse werden vor jeder Übertragung maskiert; welche Dokumente an das LLM gingen, steht im Übertragungsprotokoll.

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

## Gedächtnis

- Gespeichert werden Regeln, eigene Abläufe, Korrekturen, Vorlieben und Wissen über den Benutzer; sie werden jedem Lauf mitgegeben.
- Gespeichert wird nur auf ausdrücklichen Wunsch oder nach Rückfrage, nie aus Dokumenten.
- Nach mehreren gleichartigen Korrekturen schlägt Archivist eine Regel vor.
- Alles ist unter Einstellungen → Agent einsehbar, abschaltbar und löschbar.
- Gelerntes hebt nie Modus, Ausnahmen, Datenschutz oder Grenzen auf.

## Evaluation

Siehe [Den Agenten mit echten Modellen evaluieren](../how-to/agent-evaluieren.md).
