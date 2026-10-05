# Agentenmodus

Technische Referenz zum Agentenmodus (Epic #294). Das Konzept dahinter erklärt [Archivist als Agent](../explanation/agent.md).

Der Agentenmodus ist aktiv, wenn ein LLM mit nativem Tool-Calling konfiguriert ist. Ohne LLM, im Modus `local_only` oder bei einem Endpunkt ohne natives Tool-Calling gilt die regelbasierte Auswertung.

## Kern

Code: `packages/core/src/agent/`.

- Anbieterneutrale Schleife (`runner.ts`) mit Werkzeug-Register: Name, Beschreibung, Zod-Schema, Risikostufe `read`/`write`/`critical`, Ausführung über dieselben Service-Funktionen wie die Oberfläche.
- Ungültige Argumente gehen als Fehler-Ergebnis an das Modell zurück.
- Lesende Aufrufe einer Runde laufen parallel.
- Rückfragen (`ask_user`) sind ein eigener Ausgang; die Antwort setzt den Lauf mit vollem Kontext fort.
- **Grenzen** statt fester Schrittzahl: Token-Budget, Notbremse für Runden, Zeitlimit, Schleifenerkennung und „Stopp“. An einer Grenze fasst der Agent zusammen, was erledigt ist und was fehlt – auch wenn das Zeitlimit mitten in einer Modellanfrage abläuft. „Stopp“ und das Zeitlimit des Laufs greifen auch, während eine Antwort noch gestreamt wird. Das Zeitlimit der LLM-Einstellungen (für Agentenanfragen mindestens 2 Minuten) begrenzt bei beiden Anbietern das Warten auf die erste Antwort; über die Responses API beendet es außerdem einen Datenstrom, der so lange gar nichts mehr liefert – eine lange, aber laufende Antwort bricht es nicht ab. Einstellbar unter Einstellungen → Agent → Erweitert (`chatLimits`, `backgroundLimits`). Für Hintergrundaufgaben gibt es dort außerdem eigene Grenzen je Auslöser (`backgroundKindLimits`: Einsortieren, Archivprüfung, Verknüpfungen, geplante Abläufe); leere Felder gelten wie `backgroundLimits`.

## Anbieter

| Anbieter | Schnittstelle | SDK |
| --- | --- | --- |
| Claude | Anthropic Messages API | `@anthropic-ai/sdk`; für Microsoft Foundry `@anthropic-ai/foundry-sdk` |
| ChatGPT/OpenAI | Responses API (auch Azure OpenAI bzw. Foundry `…/openai/v1`) | eigener Fetch-Client |

- Der Adapter wird aus der Base URL erkannt (`api.anthropic.com` bzw. `…/anthropic` → Claude, sonst Responses) und lässt sich unter Einstellungen → Agent → Erweitert überschreiben.
- Der Verbindungstest prüft eine Textantwort, eine strukturierte (JSON-)Antwort, wie sie fast jede Funktion braucht, und einen echten Werkzeugaufruf mit Rückgabe und Streaming.
- Vor dem ersten Lauf prüft Archivist den Werkzeugaufruf einmal je Endpunkt, Modell und Adapter und merkt sich das Ergebnis. Scheitert die Prüfung nur vorübergehend (Limit, Serverfehler, Zeitüberschreitung, Endpunkt nicht erreichbar), merkt er sich nichts und schreibt eine Warnung ins Log: Für diese eine Chatnachricht gilt dann die regelbasierte Auswertung, der nächste Lauf prüft erneut. Jeder andere Fehler, etwa eine unvollständige Antwort oder ein abgebrochener Datenstrom, wird wie ein fehlender Werkzeugaufruf gespeichert und im Status angezeigt.
- Claude-Modelle auf Foundry bieten natives Tool-Calling am Anthropic-Endpunkt derselben Ressource (`https://<resource>.services.ai.azure.com/anthropic`) – der Dialog schlägt ihn vor.
- **Claude**: Thinking ist immer an und wird nur über `effort` gesteuert (Standard `high`); Werkzeugaufrufe werden nie erzwungen (`tool_choice: auto`); Systemanweisung und Werkzeugliste werden gecacht; Task-Budget (nur Claude API) und Kompaktierung werden genutzt, wo verfügbar, und abgeschaltet, wenn ein Endpunkt sie ablehnt.
- **OpenAI/Responses**: Alle Anfragen einer Unterhaltung tragen denselben `prompt_cache_key` (`chat:<Unterhaltungs-ID>`, ein Hintergrundlauf `run:<Lauf-ID>`), damit der Anbieter ihren gemeinsamen Anfang aus dem Cache liest. Ab 150 000 Token Kontext kompaktiert der Server den Verlauf (`context_management`, auch mit `store: false`); das verschlüsselte Kompaktierungs-Element geht danach statt des älteren Verlaufs mit, nur an dasselbe Modell. Lehnt ein Endpunkt einen der beiden Parameter ab, entfällt er.
- Der Verlauf wird anbieterneutral gespeichert – ein Wechsel des Anbieters braucht keinen Neustart.

## Websuche im Chat

- Im Chat darf der Agent im Internet suchen – über die eingebaute Websuche des Anbieters:
  - Claude: Server-Werkzeug `web_search_20260209`, das die Suchergebnisse vor dem Kontext filtert (weniger Tokens), höchstens 5 Suchen pro Anfrage. Modelle und Deployments ohne diese Filterung (ältere Modelle, Foundry gehostet auf Azure) bekommen die einfache Websuche `web_search_20250305`, gemerkt für Endpunkt und Modell,
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

Für die Schwelle zählt, was ein Aufruf tatsächlich ändern würde: `apply_rules` ohne Auswahl alle archivierten Dokumente, auf die eine Regel passt, `merge_subjects` die zusammengeführten Einträge, `decide_link_proposals` die betroffenen Vorschläge, `create_case` die zugeordneten Einträge, `export_bundle` mit `saveAsCase` die zugeordneten Dokumente. Eine Verknüpfung „auf Wunsch des Benutzers“ (`onUserRequest`) gilt nur als bestätigt, wenn deine eigene Nachricht eine Änderung verlangt oder du auf die Rückfrage „ja“ gesagt hast – sonst bleibt sie ein Vorschlag.

## Agentenläufe

- Jeder Lauf hat eine Lauf-ID mit Auslöser, Anbieter und Modell, Werkzeugaufrufen (gekürzte Ergebnisse), Tokens und geschätzten Kosten, Dauer und Ergebnis.
- Jede Änderung trägt die Lauf-ID (Änderungsprotokoll, Beziehungen mit Herkunft `agent`).
- Zum Lauf gehören nur die Änderungen seiner Werkzeuge und ihrer Dateiaufträge (siehe [Große Dateiaktionen](#große-dateiaktionen)). Andere Jobs, die währenddessen laufen – auch die von dir eingereihten –, tragen keine Lauf-ID; „Lauf rückgängig“ nimmt sie nicht zurück.
- „Lauf rückgängig“ setzt alle Änderungen in umgekehrter Reihenfolge mit Konfliktprüfung zurück, einzelne Schritte ebenso.
- Entfernt werden nur Einträge, die der Lauf selbst angelegt hat: Eine schon vorhandene identische Notiz, die `record_note` wiederverwendet, bleibt erhalten.
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
- `exclude_from_scan` nimmt nur absolute Pfade innerhalb der freigegebenen Scan-Ordner an. Ist der Pfad schon ausgeschlossen, ändert der Aufruf nichts – „Lauf rückgängig“ lässt deinen Ausschluss deshalb stehen.
- `reanalyze`: Dokumente im Eingang werden neu analysiert; archivierte und nur indexierte werden in **einem** Auftrag neu gelesen (Text, OCR, Suchindex) – Titel, Typ, Zuordnungen und Verknüpfungen bleiben.
- Umbenennen nach Schema steht mit derselben Funktion in der Dokumentliste (Mehrfachauswahl → „Umbenennen“).

## Lesen

- `find_documents` filtert nach Endung, Name, Ordner, Thema, Projekt, Typ, Person, Tag, Dokument- und Archivierungsdatum, Größe und Status, sortiert und seitenweise, mit Gesamtzahl und Ergebnismenge `S…` (`within` grenzt eine frühere Menge ein). Ergebnismengen beliebiger Größe werden vollständig aufgelöst.
- `related` liefert dieselbe Liste wie „Verwandte Einträge“ in der Oberfläche (direkte Beziehungen und gemeinsame Projekte, Vorgänge, Themen, Personen, Tags, nach Stärke, seitenweise); `depth: 2` nennt auch die Nachbarn der Nachbarn.
- Einträge, die nur aus nicht freigegebenen Dokumenten stammen, nennt `list_entries` ohne Inhalt.

## Duplikate und Versionen

- `find_duplicates` sucht unter Dokumenten drei Arten: `exact` (gleiche Prüfsumme), `near` (gleicher Text oder gleicher Textanfang – verglichen werden die ersten 200 Zeichen, spätere Unterschiede ändern die Gruppe nicht) und `versions` (gleicher Name bis auf final, v2, Kopie, (1), Entwurf oder Datum, ähnlicher Titel). Jede Gruppe nennt den Grund und das neueste Dokument. Paare, die du als verschieden markiert hast, fehlen. Nicht freigegebene Dokumente erscheinen ohne Titel.
- `mark_duplicates` behandelt Duplikate (`as: duplicate`) oder ältere Versionen (`as: older_version`) eines Dokuments, `keep` bleibt unverändert. `mark` setzt die bestätigte Verknüpfung („Duplikat von“ bzw. „ersetzt“) und das Schlagwort „Duplikat“ bzw. „ältere Version“; `subfolder` verschiebt sie zusätzlich in „Duplikate“ bzw. „Ältere Versionen“ neben `keep` (nie in einen neuen Hauptordner); `delete` legt sie in den Papierkorb und fragt immer nach. Verknüpfung, Schlagwort und Verschiebung sind einzeln rückgängig machbar, ein Agentenlauf macht sie gemeinsam rückgängig.
- `mark_different` merkt, dass zwei Dokumente oder Einträge **keine** Duplikate sind (abgelehnte „Duplikat von“-Verknüpfung). Weder `find_duplicates` noch die Archivprüfung nennen das Paar danach wieder.
- `merge_entries` führt doppelte offene Punkte, Notizen, Ereignisse, Themen, Projekte oder Personen zusammen: `keep` bleibt und übernimmt fehlende Angaben und Verknüpfungen, `duplicate` wird als Duplikat verworfen. Jede Zusammenführung ist ein Rückgängig-Schritt.
- Wissensantworten (Chat und `verified_answer`) belegen ein Dokument nur einmal: Treffer mit gleicher Prüfsumme, gleichem Textinhalt oder bestätigter „Duplikat von“-Verknüpfung zu einem besseren Treffer belegen keinen Antwortplatz, die frei werdenden Plätze gehen an weitere eigenständige Quellen.

## Recherche über mehrere Quellen

Alle Werkzeuge rechnen und vergleichen deterministisch; das Modell übernimmt nur das Ergebnis. Dokumentzeilen als Fundstelle stehen als Daten markiert mit der D-ID. Nicht freigegebene Dokumente werden übersprungen und gezählt.

- `sum_amounts`: Belegliste mit Datum, Betrag und Fundstelle, Summe und Anzahl; Dokumente ohne erkennbaren Betrag werden genannt. Als Betrag gilt die Gesamtbetragszeile (Zwischensumme, Netto und Steuer zählen nicht), sonst der größte Betrag im Dokument. `export_csv` (Spalte `betrag`) und `export_bundle` übernehmen nur die Gesamtbetragszeile; Dokumente ohne sie (etwa Verträge oder Angebote) bleiben dort ohne Betrag und zählen nicht zur Summe.
- `find_gaps`: Lücken in einer Serie nach Monat (`by: month`) oder laufender Nummer (`by: number`); erstes und letztes Dokument der Serie stehen mit der Fundstelle (Zeile mit dem Datum bzw. der Nummer) im Ergebnis.
- `compare_documents`: vergleicht zeilenweise. Geänderte Zeilen stehen in einer Tabelle „In A (alt) | In B (neu) | Änderung“ (z. B. „Miete 800 € → 850 €“), danach Zeilen nur in A und nur in B. Mit `weitere` wird das erste Dokument mit jedem weiteren verglichen (B1, B2, …). Alle Dokumente müssen freigegeben sein.
- `find_deadlines`: Fristen und Ablaufdaten mit Rechenweg und Fundstelle; nennt bestehende Erinnerungen.
- `match_payments`: ordnet Rechnungen Buchungen aus Kontoauszügen zu (Rechnungsnummer oder Betrag) und nennt offene Rechnungen und Zahlungen ohne Rechnung.
- `timeline`: Zeitlinie zu `topic`, `project` oder Zeitraum. Mit `case` (Vorgang) werden Dokumente, Entscheidungen, offene Punkte, Ereignisse und Notizen des Vorgangs chronologisch verschränkt; vorgeschlagene, nicht bestätigte Zuordnungen zählen nicht.
- `verified_answer` schließt eine Recherche mit der geprüften Antwortlogik des Chats ab: Quellen suchen, Aussagen gegen Belege prüfen, Unsicheres unter „Unsicherheiten“ kennzeichnen.

## Wissen erfassen

- Entscheidungen, Notizen, offene Punkte, Erinnerungen und Ereignisse erfasst ein Modul (`services/capture.ts`): Pflichtangaben und Rückfragen, Dubletten-Prüfung, Personen-Auflösung, Ersetzen und Widerspruchsprüfung.
- Die Erfassungswerkzeuge des Agenten und der regelbasierte Chat rufen dasselbe Modul auf. Rückfragen stellt der Agent über `ask_user`, der regelbasierte Chat über seine Rückfrage im Gespräch.
- `chat.ts` enthält nur noch den Gesprächsablauf und den regelbasierten Rückfall (Absicht-Klassifikation und `dispatch()`).
- Ist beim Ersetzen nicht eindeutig, welche ältere Entscheidung gemeint ist, nennt `record_decision` die Kandidaten mit ihren K-IDs; nach der Rückfrage legt `supersede_decision` die Vorschlagskarte an. Als überholt markiert wird erst nach deiner Bestätigung.
- `create_subject` legt nur an, was es noch nicht gibt. Eine Person erkennt es auch ohne Titel oder Rolle („Dr. Thomas Müller“) und unter deinem Profilnamen oder Spitznamen als dich selbst; dann meldet es den vorhandenen Eintrag, und „Lauf rückgängig“ löscht ihn nicht.
- `set_metadata` ändert bei Entscheidungen, offenen Punkten und Ereignissen auch Titel, Personen (Beteiligte bzw. Verantwortliche) und Datum (Entscheidungsdatum, Fälligkeit, Ereignisdatum).
- Datumsangaben ohne Jahr: „31.10.“ ist bei einer Entscheidung der letzte 31. Oktober, bei einer Erinnerung oder Fälligkeit der nächste.

## Verknüpfungsmethoden

Die festen Methoden aus Epic #269 als eigene Werkzeuge, mit denselben Service-Funktionen wie die Oberfläche (`services/link-methods.ts`). Alle schlagen nur vor; abgelehnte Paare kommen nie wieder.

| Werkzeug | Methode |
| --- | --- |
| `suggest_links` | ähnliche Einträge (Kosinus der gespeicherten Abschnittsvektoren; lokale Hash-Vektoren mit höherer Schwelle als echte Embeddings) und genannte Themen/Projekte, bis zu 3 je Eintrag |
| `find_unlinked_entries` | Einträge ohne bestätigte oder vorgeschlagene Beziehung (ein Ordner allein zählt nicht), seitenweise, rein per SQL |
| `find_topic_clusters`, `propose_topic` | Gruppen ähnlicher Einträge ohne Thema als Hinweis „Neues Thema ‚…‘ anlegen?“; „Ja“ legt an und ordnet zu (rückgängig machbar), „Nein“ wird gemerkt |
| `backfill_links` | rückwirkender Lauf über das Archiv mit allen Methoden (ähnlich, gleicher Tag + Person, gleiches Quelldokument, Analyse von Notizen); prüft nur neue oder geänderte Einträge (Markierung je Eintrag) |
| `linkage_report` | Verknüpfungsgrad: Anteil verwaister Einträge, offene Vorschläge, Bestätigungsquote je Methode, Verlauf der Archivprüfungen und die aus Ablehnungen gelernten Schwellen (nur lesen) |
| `reset_learned_thresholds` | setzt die gelernten Schwellen zurück; nicht rückgängig machbar, fragt deshalb immer (kritisch) |

Weitere Werkzeuge für die Verknüpfungen:

| Werkzeug | Zweck |
| --- | --- |
| `set_metadata` | `topic`/`project` ersetzen das Hauptthema bzw. -projekt (Ablage). `addTopics`/`addProjects` ergänzen weitere – wer noch keins hat, bekommt es als Hauptthema –, `removeTopics`/`removeProjects` entfernen weitere; `case` ordnet einem vorhandenen Vorgang zu; `addTags` gilt für alle Arten von Einträgen. Ergänzungen sind wie die Sammelzuordnung ein Rückgängig-Schritt |
| `link` | auch `subtopic_of`: ein Thema oder Projekt unter ein anderes einordnen (keine Kreise) |
| `update_note` | Titel und Text einer Notiz ändern (nur auf Wunsch); ohne neuen Titel bleibt der bisherige. `[[Name]]` verlinkt, unbekannte Namen meldet das Werkzeug zum Anlegen |
| `case_overview` | ein Vorgang mit Status, offenen Punkten und Verlauf (nur lesen; Dokumentnamen nur mit Freigabe) |
| `list_subjects` | zeigt bei Unterthemen das Oberthema |

- Dieselben Vorschläge zeigen die Erfassungswerkzeuge nach dem Speichern und die Wissensseite unter „Vorschläge zum Verknüpfen“.
- Der Hintergrund-Lauf „Verknüpfungen“ arbeitet mit diesen Werkzeugen.
- Ohne Agent startet der rückwirkende Lauf einmal nach dem Update und unter Einstellungen → Agent → Agentenläufe auf Knopfdruck, dann über das ganze Archiv (lokal, ein gebündelter Hinweis am Ende). Sonst prüft der Lauf nur, was neu oder geändert ist.

## Fristen und Ablaufdaten

- `find_deadlines` erkennt Fristen und Ablaufdaten (Kündigung, Garantie, Ausweis, Versicherung, TÜV/HU, Widerspruch, Ablauf, Fälligkeit) deterministisch mit Fundstelle und Rechenweg. Ohne Angabe prüft es alle archivierten Dokumente: die neuesten 1000, vorbeigegangene Fristen ausgelassen, höchstens 60 Fristen je Aufruf; der Rest wird gezählt.
- Je Frist (nicht je Dokument) steht dabei, ob schon eine Erinnerung oder ein offener Punkt besteht. Eine Erinnerung gilt für die Frist, wenn sie zum Dokument gehört und mit ihr angelegt wurde (Titel „Kündigungsfrist 30.09.2026: …“) oder am Tag der Frist liegt; ein offener Punkt, wenn das Dokument seine Quelle ist und er am Tag der Frist fällig ist.
- Nicht zur Übertragung freigegebene Dokumente werden nicht ausgewertet: keine Titel, Daten oder Fundstellen, nur Anzahl und Verweise („übersprungen“).
- `create_reminder` nimmt für eine gefundene Frist `deadline` (Art und Datum) und `target` (das Dokument). Ohne `remindAt` liegt die Erinnerung so viele Tage vor der Frist, wie der Vorlauf des Fristen-Wächters (Einstellungen → Agent) angibt, frühestens heute. Gibt es für dieselbe Frist schon eine Erinnerung oder einen offenen Punkt, wird nichts angelegt und das gemeldet; eine schon vorbeigegangene Frist lehnt das Werkzeug ab. Zwei Fristen in einem Dokument bekommen je eine eigene Erinnerung.
- Der Agent legt für eine Frist ohne Erinnerung eine an, wenn du Fristen im Blick behalten willst.

## Spezialaufgaben

Aufgaben für besondere Fälle (Story #312). Alles Rechnen und Erkennen läuft lokal und deterministisch; das Modell liest nur das Ergebnis. Dokumentinhalte (Fundstellen, Buchungszeilen) stehen als markierte Daten im Ergebnis, nicht freigegebene Dokumente nur mit Endung, Ordner und Status.

| Werkzeug | Stufe | Zweck |
| --- | --- | --- |
| `match_payments` | lesen | Rechnungen mit Kontoauszügen abgleichen (Rechnungsnummer im Verwendungszweck oder gleicher Betrag 0–90 Tage nach dem Rechnungsdatum). Lesbar sind Zeilen `TT.MM.JJJJ Text -Betrag` (auch `JJJJ-MM-TT`) und CSV-Zeilen `TT.MM.JJJJ;Text;-Betrag` (Trenner `;` oder Tab, Komma oder Punkt als Dezimaltrenner, optionale Währungsspalte). Wird keine Buchung erkannt, sagt das Werkzeug es, statt zu raten |
| `match_receipt_photos` | lesen | Belegfotos (PNG/JPG mit erkanntem Text): schlägt den passenden Beleg, Vorgang bzw. das Projekt vor – nach Betrag (50 Punkte), Datum (bis 3 Tage 30, bis 14 Tage 15) und Händler (20); ab 50 Punkten gibt es einen Vorschlag. Fundstellen aus dem Fototext stehen als Daten im Ergebnis. Zugeordnet wird nur auf Wunsch mit `set_metadata` bzw. `add_to_case` |
| `email_threads` | lesen | E-Mail-Verläufe (mindestens zwei Nachrichten). Mit `Message-ID`, `In-Reply-To` und `References` (der .eml-Parser speichert sie lokal in den technischen Metadaten) werden Verläufe auch ohne gemeinsamen Betreff zusammengehalten und gleiche Betreffs verschiedener Verläufe getrennt. Mails ohne diese Kopfzeilen (vor dem Update gelesen – „Erneut lesen“ holt sie nach) werden nach Betreff gruppiert; das Ergebnis nennt je Verlauf die Grundlage |
| `file_mail_thread` | schreiben (neue Hauptkategorie: kritisch) | Einen Verlauf zusammen ablegen: die Nachrichten werden mit der ersten bestätigt verknüpft und in einen gemeinsamen Ordner verschoben. Alles trägt die Lauf-ID; „Lauf rückgängig“ nimmt Verknüpfungen und Verschiebung zurück |
| `capture_device` | schreiben | Gerät mit Beleg erfassen: Seriennummer (aus dem Beleg nach `Seriennummer`, `S/N`, `Serial No` oder angegeben; geprüft: 5–30 Zeichen, mindestens eine Ziffer) und Garantieende als Notiz „Gerät: …“, bestätigt verknüpft mit dem Beleg, plus eine Erinnerung am Garantieende (am Beleg, für denselben Tag nie doppelt; keine, wenn die Garantie schon abgelaufen ist). Garantieende: `warrantyEnd`, sonst Kaufdatum (Belegdatum) + `warrantyMonths`, sonst die im Beleg genannte Garantiezeit, sonst die gesetzlichen 24 Monate – als Annahme genannt –, immer mit Rechenweg. Rückgängig nimmt Notiz, Verknüpfung und Erinnerung zurück |
| `resolve_person` | lesen | Welche bekannte Person ist gemeint (Name, Alias, Spitzname, „ich“ = Benutzer); bei Mehrdeutigkeit fragt der Agent nach |
| `add_person_alias` | schreiben | Weitere Namen für eine Person merken, z. B. „Tochter“ und „meine Tochter“; ein Name, den schon eine andere Person trägt, wird nicht vergeben. Rückgängig machbar |
| `find_documents` (`person`) | lesen | Der Personenfilter läuft über dieselbe Auflösung wie `resolve_person`: „meine Tochter“ findet die Dokumente der Person mit diesem Alias. Ist keine Person bekannt, bleibt es ein Textvergleich |
| `find_secrets` | lesen | Passwörter, Zugangsdaten, PINs, IBANs und Schlüssel erkennen – nur Art und Anzahl je Dokument, nie die Werte |
| `exclude_from_llm` | kritisch | Dokumente von der Analyse durch das LLM ausschließen (oder wieder freigeben); fragt immer nach |
| `problem_files` | lesen | Fehlgeschlagene und in Quarantäne gelegte Dokumente, verschlüsselte PDFs, Endung passt nicht zum Dateityp, lesbare Dateien (auch PNG/JPG) ohne erkannten Text – mit Erklärung |
| `find_foreign_language_documents` | lesen | Archivierte Dokumente, die nicht auf Deutsch (oder der gewählten Sprache) sind, mit erkannter Sprache (Deutsch, Englisch, Französisch, Spanisch, Italienisch). Die Sprache wird lokal aus häufigen Wörtern erkannt (ohne Abhängigkeit); kurze, zahlenlastige oder gemischte Texte bleiben „unklar“. Suchbegriffe übersetzt das Modell selbst und gibt sie bei `search` als `alsoTry` mit; deren Treffer kommen nach denen des Suchbegriffs |
| `storage_report` | lesen | Größte Dateien, exakte Duplikate mit verschwendetem Platz, Dokumente ohne Thema, Projekt oder Verknüpfung. Archivist erfasst nicht, wann ein Dokument zuletzt geöffnet wurde; „Vermutlich lange nicht genutzt“ ist deshalb eine Näherung (älteste archivierte Dokumente ohne Bezug), und der Bericht sagt das |
| `set_setting` | schreiben; Datenschutz, Massenschwelle und automatische Analyse: kritisch | Einstellungen auf Wunsch ändern; rückgängig machbar |
| `exclude_from_scan` | schreiben | Datei oder Verzeichnis vom Scan ausschließen (nur in freigegebenen Scan-Ordnern); rückgängig machbar |

## Archivist untersuchen

Zwei Werkzeuge der Stufe **lesen** (keine Bestätigung, ändern nichts) lassen den Agenten nachsehen, warum sich Archivist so verhält, wie es sich verhält – etwa warum die Suche nur lokale Treffer liefert. Es gibt bewusst kein Werkzeug, das Befehle oder eine Shell ausführt; beide Werkzeuge liefern nur fest umrissene Auskünfte.

| Werkzeug | Stufe | Zweck |
| --- | --- | --- |
| `read_logs` | lesen | Das lokale Protokoll (`logs/archivist-JJJJ-MM-TT.log`). Argumente: `from`/`to` (Tage, UTC, höchstens 14 Tage, Standard heute), `minLevel` (`debug` bis `error`, Standard `warn`), `scope` (z. B. `search`, `llm`, `scanner`; Länge bis 40) und `limit` (1–200, Standard 50) |
| `diagnose` | lesen | Ohne Argumente: Versionen (Archivist, Electron, Node), Größe des Datenordners und freier Speicher, Datenbankgröße und Zeilen je Haupttabelle, eingestelltes LLM- und Embedding-Modell, Textabschnitte je Embedding-Modell, Datenschutzmodus, Antwortzeit des Embedding-Endpunkts und die letzten fünf fehlgeschlagenen Aufträge |

**`read_logs`**

- Geliefert werden die neuesten passenden Zeilen, älteste zuerst. Von einer sehr langen Tagesdatei wird nur das Ende (2 MB) gelesen, eine Zeile hat höchstens 500 Zeichen, das ganze Ergebnis höchstens etwa 10 000 Zeichen; das Ergebnis nennt, was dabei weggefallen ist.
- Jede Zeile läuft noch einmal durch dieselbe Bereinigung wie beim Schreiben (Schlüssel, Passwörter und Token sowie, nach Einstellung, IBAN, Kartennummern und Ausweiskennungen maskiert, Felder wie `content` oder `prompt` nur mit Länge). Zeilen, die nicht im Format des Protokolls stehen, werden verworfen und gezählt: Zurück kommt nie etwas, was der Logger nicht geschrieben hätte.
- Zeilen, die eine ausgeschlossene Datei, einen ausgeschlossenen Ordner oder Dateityp nennen (Einstellungen → Datenschutz, KI-Freigabe eines Scan-Verzeichnisses, ausgeschlossene Dokumente), werden weggelassen und nur gezählt. Der Vergleich ist bewusst großzügig: Im Zweifel fehlt eine Zeile lieber.
- Der Inhalt steht als markierte Daten im Ergebnis, nie als Anweisung. Liest sich eine Zeile wie eine Aufforderung an den Agenten, ändert der Lauf nichts ohne deine eigene Bitte (wie bei Dokumenten).

**`diagnose`**

- Textabschnitte je Embedding-Modell zeigt, welche noch mit dem lokalen `local-hash-v1` (oder ohne Vektor) vorliegen, und wie viele nicht zum eingestellten Modell passen.
- **Endpunkt-Messung:** Nur im Datenschutzmodus „automatisch“ und mit eingestelltem Embedding-Modell geht eine einzige feste Testanfrage (`Verbindungstest`, ohne Dokumentinhalt und ohne Dokument-IDs) über den normalen LLM-Client an den Endpunkt – maskiert und im Übertragungsprotokoll (Zweck „Diagnose: Embedding-Endpunkt“). In „vorher fragen“, „nur lokal“ und ohne LLM-Konfiguration geht nichts hinaus, und `diagnose` sagt, warum. Die Anfrage gilt das Zeitlimit der LLM-Einstellungen; zum Vergleich nennt der Befund das Limit der Suche (2,5 s).
- Fehlgeschlagene Aufträge erscheinen als markierte Daten; nennt Label oder Fehler eine ausgeschlossene Datei, steht nur „nicht freigegeben“ da.

## Sicherheit

- Dokumentinhalte gehen nur als markierte Daten an das Modell, nie als Anweisungen. Enthält ein Dokument eine Aufforderung an den Agenten, ändert der Lauf nichts ohne eigene Bitte des Benutzers (im Hintergrund nur als Vorschlag).
- Jedes Werkzeugergebnis läuft durch den Datenschutzfilter: Nicht freigegebene Dokumente erscheinen nur mit Endung, Ordner und Status.
- Geheimnisse und, solange `privacy.maskPersonalData` an ist, persönliche Kennungen wie IBAN werden vor jeder Übertragung maskiert – in deiner Nachricht, in Werkzeugergebnissen und in der Systemanweisung (Gelerntes, Profil); welche Dokumente an das LLM gingen und wie viele Stellen maskiert wurden, steht im Übertragungsprotokoll.
- Wird ein Dokument nach dem Lesen ausgeschlossen oder sein Ordner gesperrt, gehen frühere Werkzeugergebnisse und Antworten des Gesprächs, die es nennen, nicht erneut an das Modell (#202); Gedankenblöcke des Anbieters entfallen dann.
- Alle Datei-Werkzeuge bleiben im Archiv (Exporte im Datenordner); Path-Traversal und Symlinks, die hinausführen, werden abgelehnt.

## Verbrauch

- Tokens pro Anfrage und Lauf, getrennt nach frischer Eingabe, aus dem Cache gelesen, in den Cache geschrieben und Ausgabe. Aus dem Cache gelesene Tokens kosten nur einen Bruchteil frischer Eingabe (meist 10 %, bei Claude Opus 5.5 5 %, bei Claude Fable 5.1 2,5 %); die Laufzeile nennt deshalb zuerst die geschätzten Kosten und bei den Tokens den Anteil aus dem Cache. Kompaktiert Claude den Verlauf, zählen die Tokens dieses Schritts mit (`usage.iterations`).
- Kosten aus einer pflegbaren Preistabelle – nur zur Information. Ein Modell gilt nur für seine eigene Version: `gpt-5` gilt für `gpt-5-…`, nicht für `gpt-5.5`; eine unbekannte Version hat keinen Preis statt eines falschen. Eigene Preise (Einstellungen → Agent) haben Vorrang.
- Die Tokens aller Anfragen, auch der Agentenläufe, stehen im Übertragungsprotokoll und zählen für das optionale **Tageslimit** (`llm.dailyTokenCap`, [LLM-Schnittstelle](llm-schnittstelle.md#tokenverbrauch-und-tageslimit)): Ist es erreicht, starten Hintergrundläufe nicht, und im Chat fragt Archivist vorher, ob er trotzdem fortfahren soll.
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

**Fristen-Wächter** (ohne LLM, einmal pro Tag, eine gebündelte Benachrichtigung):

- Er meldet offene Punkte und ausstehende Erinnerungen bis zum Vorlauf (Standard 14 Tage), auch überfällige, sowie Fristen aus freigegebenen archivierten Dokumenten, für die weder Erinnerung noch offener Punkt besteht. Vorbeigegangene Dokumentfristen meldet er nicht.
- Die Benachrichtigung hat bis zu drei Knöpfe zu den betroffenen Seiten (Dokument oder „Offene Punkte“).
- Ein gemeldeter Eintrag kommt erst wieder, wenn er in zwei Tagen fällig oder überfällig ist. Gemerkte Einträge, die nicht mehr anstehen, werden vergessen.

**Wochenrückblick** (ohne LLM, am eingestellten Wochentag, in einem eigenen Gespräch):

- Neu archivierte Dokumente, Entscheidungen, offene Punkte (erledigt, neu, offen), anstehende Fristen der nächsten 14 Tage einschließlich Dokumentfristen, offene Vorschläge und Hinweise sowie die Hintergrundläufe.
- Einträge sind mit der Seite in der App verlinkt (`[Titel](/documents/?id=…)`, `/decisions/?id=…`, `/open-items/`). Titel nicht freigegebener Dokumente fehlen, sie werden nur gezählt.
- Was schon der letzte Rückblick nannte (offene Punkte, Fristen, Vorschläge), wird nur gezählt: „Weiterhin offen/anstehend seit letzter Woche: N“.


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
