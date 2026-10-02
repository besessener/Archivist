# Funktionen im Detail

Genaues Verhalten jedes Funktionsbereichs. Für den Agentenmodus siehe [Agentenmodus](agentenmodus.md), für Bestätigungen und Dateischutz [Aktionsstufen und Schutzregeln](aktionsstufen.md).

- [Chat](#chat)
- [Decision Tracking](#decision-tracking)
- [Dokumente](#dokumente)
- [Wissensgraph](#wissensgraph)
- [Verknüpfungen](#verknüpfungen)
- [Personen und eigene Identität](#personen-und-eigene-identität)
- [Suche](#suche)
- [Verzeichnisscan](#verzeichnisscan)
- [Archivprüfung (Konsistenzschleife)](#archivprüfung-konsistenzschleife)
- [Timeline, Erinnerungen, Benachrichtigungen](#timeline-erinnerungen-benachrichtigungen)
- [Job-Queue](#job-queue)
- [Änderungsprotokoll und Undo](#änderungsprotokoll-und-undo)
- [Backups](#backups)
- [OCR](#ocr)

## Chat

Der Chat ist die zentrale Schnittstelle.

- **Intent-Erkennung**: LLM-gestützt, strukturiert und Zod-validiert. Erkannt werden Entscheidungen, Notizen, Wissensfragen, Dokumentsuche, Timeline, offene Punkte, Erinnerungen, Archivierung, Scan, Ausschlüsse und Widersprüche.
- **Mehrere Absichten pro Nachricht** werden nacheinander ausgeführt; Rückfragen stellen die übrigen zurück. Legt eine Nachricht mehrere offene Punkte an, gilt die Antwort auf „Bis wann?“ bzw. „Wer ist verantwortlich?“ für alle („für alle drei 31.12.2026“), außer sie nennt einzelne Punkte.
- **Kontext**: Das LLM kennt die aktiven offenen Punkte, Entscheidungen und offenen Vorschläge des Gesprächs (nur Titel und Metadaten, mit IDs) sowie deinen Namen (Einstellungen → Über dich).
- **Rückfrage statt Raten** bei unklarer Absicht und **bevor eine unsichere „Entscheidung“ gespeichert wird** (Entscheidung / Ereignis / Notiz / nichts speichern).
- **Ereignisse** („am 01.10.2026 eingereicht“) landen mit Datum in der Timeline.
- **Antworten** mit Quellen, getrennten Fakten/Interpretation und sichtbaren Unsicherheiten. Wie Quellen geprüft werden: [LLM-Schnittstelle](llm-schnittstelle.md#antworten-auf-wissensfragen).
- **Wissensgraph in Antworten**: Bestätigte Verknüpfungen der besten Treffer bringen weitere Quellen mit (z. B. die Entscheidung, die ein gefundenes Dokument stützt); unter der Quelle steht, über welche Verknüpfung sie dazukam.
- **Abbrechen**: Eine laufende Anfrage lässt sich abbrechen; Erledigtes bleibt, der Rest entfällt.
- **Ausfall-Schutz**: Nach einer Zeitüberschreitung oder einem unerreichbaren Endpunkt scheitern LLM-Anfragen 60 s lang sofort, statt erneut zu warten (der Verbindungstest geht immer durch).
- **Bestätigen per „ja“**: bestätigt nur Vorschläge, die **in diesem Gespräch** als Karte angezeigt werden und noch offen sind; sind es mehrere, fragt Archivist nach.

## Decision Tracking

- Pflichtfelder: *Wann, Thema, Beteiligte, Entscheidung*.
- Gezielte Rückfragen; die Entscheidung bleibt Entwurf, bis alles vollständig ist oder ausdrücklich als „unbekannt“ bestätigt wurde.
- Ersetzen/Widerrufen nur nach Bestätigung (auch aus dem Formular) und rückgängig machbar.

## Dokumente

- **Import** per Drag-and-Drop oder Dateiauswahl in einen sicheren Eingang (`inbox/`), mit Prüfsumme und Duplikaterkennung.
- **Parser** für PDF, DOCX, PPTX, XLSX, EML, TXT/MD, PNG/JPG (Bilder und Scans per [OCR](#ocr)).
- **Klassifikation** per LLM oder lokal, mit menschenlesbarem Zielpfad.
- **Archivierung** per Kopieren (Standard), Verschieben, nur Indexieren oder Ignorieren; Undo.
- **Nur indexierte Dokumente**: Ändert sich das Original, wird es beim nächsten Scan bzw. bei der Archivprüfung (andere Dateigröße) lokal neu eingelesen und neu indexiert – kein zweites Dokument, kein veralteter Inhalt in der Suche. Fehlt das Original, meldet die Archivprüfung „Original fehlt“.
- **Archivierte Dokumente**: Wird das Original geändert und neu analysiert, wird das neue Dokument als Ersatz („ersetzt“, Vorschlag) des archivierten verknüpft.
- **Quarantäne**: Dateien, deren Inhalt nicht zur Endung passt, landen in `quarantine/` und erscheinen in der Inbox unter „Quarantäne“ („Ordner öffnen“ oder nach Bestätigung „Trotzdem importieren“).
- Bei reinen HTML-E-Mails fällt für den Leser unsichtbarer Text (`display:none`, `font-size:0`, …) aus dem Dokumenttext heraus.

## Wissensgraph

- **Entitäten**: Document, Decision, Topic, Project, Person, Event, Question→Task, Note, Category, Tag.
- **Beziehungen** mit Confidence und Status `proposed`/`confirmed`/`rejected`/`outdated`, gespeichert in SQLite.
- **Zusammenführen** von Themen, Projekten (auch Thema ↔ Projekt), Personen und Tags hängt Beziehungen, Thema/Projekt-Verweise (Dokumente, Entscheidungen, offene Punkte, Ereignisse), Beteiligte, Personen und Verantwortliche um, merkt alte Namen als Aliasse und indexiert neu. Es lässt sich exakt rückgängig machen – auch mehrere Zusammenführungen eines Laufs auf einmal.
- **Mehrere Themen und Projekte**: Dokumente, Entscheidungen, offene Punkte und Ereignisse haben ein Hauptthema und ein Hauptprojekt (danach richtet sich die Ablage im Archiv) und beliebig viele weitere – in den Formularen unter „Weitere Themen“ / „Weitere Projekte“. Weitere sind bestätigte Beziehungen derselben Art wie die zum Hauptthema; Listen zeigen sie mit „+ …“, Filter nach Thema oder Projekt finden den Eintrag unter jedem davon, und die Archivprüfung zählt ihn als zugeordnet. Ändern ist ein Rückgängig-Schritt; Zusammenführen hängt auch weitere Themen um. Eine Migration hat jedem vorhandenen Hauptthema und -projekt seine Beziehung gegeben.
- **Veraltete Beziehungen**: Ändern sich Thema, Projekt, Beteiligte, Personen oder Tags (auch beim Bearbeiten eines archivierten Dokuments) oder der Verantwortliche eines offenen Punkts, werden die automatisch angelegten Beziehungen zum alten Ziel `outdated`. Von dir bestätigte oder abgelehnte bleiben unverändert; Rückgängig stellt sie wieder her.
- **Verantwortliche** sind als Beziehung „verantwortlich für“ mit ihrem offenen Punkt verbunden.
- **Ereignisse** haben Beteiligte (Dialog, Chat, Graph „beteiligt an“).
- Beim Archivieren werden **alle** Personen und Tags verknüpft.
- **„Neu anlegen“** auf der Wissen-Seite erzeugt echte Einträge (Ereignisse mit Datum über den Timeline-Dialog, Notizen indexiert) und öffnet bei einem bereits vorhandenen Eintrag diesen mit dem Hinweis „existiert bereits“.
- **Unbestätigte Themen und Projekte**: Unverändert aus einem Dokument übernommene Themen und Projekte sind auf der Wissen-Seite „unbestätigt“ und werden dem Modell erst nach deiner Bestätigung (oder sobald du den Namen selbst verwendest) als bekannt genannt.
- **Notizen bearbeiten**: „Bearbeiten“ auf der Wissen-Seite ändert Titel und Text einer Notiz; danach wird sie neu indexiert und neu analysiert. Rückgängig im Änderungsprotokoll.

## Verknüpfungen

Wie und warum Archivist Einträge verknüpft: [Wie Archivist Wissen verknüpft](../explanation/verknuepfungen.md). Vorschläge prüfen: [Verknüpfungsvorschläge prüfen](../how-to/verknuepfungen-pruefen.md).

**Herkunft, Methode und Beleg.** Jede Beziehung speichert:

| Feld | Werte |
| --- | --- |
| Herkunft (`origin`) | `system` (feste Methoden), `user`, `agent` (mit Lauf-ID) |
| Methode (`method`) | `field` (Feld des Eintrags: Thema, Projekt, Personen, Tags, Ordner), `analysis` (Analyse eines Dokuments oder einer Notiz), `similarity`, `mention`, `co_origin`, `date_person`, `wikilink`, `manual`, `agent` |
| Beleg (`evidence`) | kurzer Text, höchstens 300 Zeichen: die ähnlichste Textstelle, die Nachricht, „Am 01.09.2026 mit „Anna““ … |

Die Oberfläche zeigt je Beziehung „automatisch“, „vom Agenten“, „von dir bestätigt“, „von dir abgelehnt“ oder „manuell“, dazu Methode und Beleg. Ein bestätigter Feld-Spiegel gilt nur dann als „von dir bestätigt“, wenn du ihn bestätigt hast.

**Automatische Methoden** – alle legen nur Vorschläge (`proposed`) an:

| Methode | Wann | Was |
| --- | --- | --- |
| Ähnlicher Inhalt (`similarity`) | nach jedem (Neu-)Indexieren eines Eintrags, im Job `links.similar` | `related_to` zu ähnlichen Einträgen (Kosinus der Abschnittsvektoren; Schwelle 0,45 mit Embeddings, 0,5 mit lokalen Vektoren), höchstens N offene je Eintrag (Standard 3) |
| Gleicher Tag + gleiche Person (`date_person`) | im selben Job | Ereignisse, Entscheidungen und Dokumente mit demselben fachlichen Datum (Ortszeit) und einer gemeinsamen Person; die eigene Person zählt nicht |
| Gemeinsam entstanden (`co_origin`) | sofort | Einträge aus derselben Chat-Nachricht (paarweise, ab 7 in einer Kette) und Einträge aus demselben Quelldokument |
| Analyse einer Notiz (`analysis`) | nach Anlegen und Bearbeiten, im Job `notes.analyze` | Thema, Projekt, Personen und Tags; per LLM nur im Modus „automatisch“, sonst lokal (bekannte Namen, Aliasse, `#Hashtags`). Was eine neue Analyse nicht mehr findet, wird `outdated` |

- Übersprungen werden schon verknüpfte Paare, Eingangsdokumente, verworfene Duplikate und **abgelehnte Paare**: Ein abgelehntes Paar schlägt keine Methode wieder vor – in beiden Richtungen, unabhängig von der Art, auch nachdem einer der beiden als Duplikat in einen anderen Eintrag zusammengeführt wurde. Ein abgelehntes „Duplikat“ heißt nur „verschieden“ und blockiert nichts.
- Abschaltbar unter Einstellungen → Agent → Agentenläufe → „Verknüpfungen automatisch vorschlagen“ (`links.autoPropose`), dort auch die Höchstzahl je Eintrag.
- **Aus Ablehnungen lernen** (behutsam): Zählt werden deine letzten 40 Entscheidungen je Methode (ab 8). Lehnst du mehr als die Hälfte ab, steigt die Schwelle der Methode – bei 90 % Ablehnung bis zum Deckel von 0,1 (ähnlicher Inhalt: Mindest-Ähnlichkeit; gleicher Tag + gleiche Person: Mindest-Konfidenz, die mit jeder weiteren gemeinsamen Person um 0,1 steigt). Bestätigungen senken sie wieder. Auch am Deckel kommen die stärksten Vorschläge noch, keine Methode wird abgeschaltet. Einsehen und zurücksetzen unter Einstellungen → Agent → Agentenläufe → „Aus Ablehnungen gelernt“.

**Verknüpfungsvorschläge prüfen** (Insights, ganz oben): alle offenen Vorschläge der Methoden, gruppiert nach Methode oder Eintrag, je mit Beleg; 20 je Seite mit Gesamtzahl. „Bestätigen“, „Ablehnen“ und „Alle bestätigen“ (die ganze Gruppe, auch über die Seite hinaus) sind je ein Rückgängig-Schritt. Widersprüche, Versionen und Dubletten haben eigene Abläufe und erscheinen dort nicht. Benachrichtigt wird nur bei neuen Vorschlägen: eine Benachrichtigung, die sich aktualisiert, solange sie ungelesen ist.

**Verknüpfungsgrad** (Insights, über den Vorschlägen): Anteil verwaister Einträge, Zahl offener Vorschläge und die Bestätigungsquote deiner Entscheidungen – gesamt und je Methode. Jede Archivprüfung speichert einen Messpunkt (die letzten 400); der Verlauf zeigt den Anteil verwaister Einträge, als Tabelle auch alle Werte. Ein Klick auf eine Kennzahl öffnet die verwaisten Einträge, die Vorschlagsliste bzw. die Quoten je Methode.

**Verwandte Einträge** in Dokument- und Entscheidungsdetails, auf der Wissen-Seite und als „Zusammenhänge“ bei offenen Punkten:

- direkte Beziehungen und Verbindungen über gemeinsame Projekte, Vorgänge, Themen, Personen (nicht die eigene) und Tags;
- sortiert nach Stärke (bestätigt 10, vorgeschlagen 5, Projekt/Vorgang 4, Thema 3, Person 2, Tag 1) mit Begründung wie „gleiches Projekt „Hausbau“ + gleiche Person „Anna““;
- Vorschläge direkt bestätigen oder ablehnen; 10 je Seite;
- Knoten mit mehr als 500 Einträgen zählen nicht; abgelehnte Paare fehlen.

**Vorschläge beim Erfassen im Chat**: Nach dem Speichern einer Notiz, Entscheidung, eines offenen Punkts oder Ereignisses erscheinen unter der Antwort bis zu drei Knöpfe wie „Das klingt nach Projekt „Hausbau“ – verknüpfen?“ – aus der Ähnlichkeitssuche, genannten Themen und Projekten und der Notiz-Analyse. Sie werden in einem eigenen Job ermittelt, die Antwort wartet nicht darauf. Ein Klick bestätigt die Verknüpfung (rückgängig im Änderungsprotokoll); ignorierte Vorschläge bleiben in den Verknüpfungsvorschlägen.

**Manuell verknüpfen**: „Verknüpfen“ wählt per Suche einen Eintrag beliebiger Art und die Art der Beziehung (verwandt, folgt aus, ersetzt, blockiert …). Manuelle Verknüpfungen sind sofort bestätigt, stehen im Änderungsprotokoll, lassen sich rückgängig machen und wieder entfernen. Im Chat verknüpft der Agent auf Wunsch („Verknüpfe das mit dem Mietvertrag“) und fragt bei mehreren Treffern nach.

**Vorgänge** (z. B. „Steuererklärung 2025“, „Autokauf“) sammeln Dokumente, Entscheidungen, offene Punkte, Ereignisse und Notizen zu einer Sache:

- Anlegen auf der Wissen-Seite („Neu anlegen“ → Vorgang) oder direkt beim Zuordnen; Name, Beschreibung, Status offen/abgeschlossen.
- Zuordnen über „Zu Vorgang hinzufügen“ in den Details eines Eintrags, per Mehrfachauswahl in den Listen oder im Chat („Leg das in den Vorgang Autokauf“). Ein Eintrag kann zu mehreren Vorgängen gehören.
- Ist ein Eintrag einem Eintrag eines offenen Vorgangs ähnlich, wird er für diesen Vorgang vorgeschlagen (Methode `similarity`, Beleg „ähnlich wie … aus dem Vorgang …“).
- Die Seite eines Vorgangs zeigt seine offenen Punkte und alle Einträge als Verlauf (neueste zuerst, nach fachlichem Datum).
- Nennt eine Wissensfrage einen Vorgang, zählen seine Einträge als Quellen („Teil des Vorgangs …“).
- Anlegen, Zuordnen (auch mehrerer Einträge in einem Schritt) und Abschließen sind rückgängig machbar.

**Sammelzuordnung**: In den Listen der Dokumente, Entscheidungen, offenen Punkte, der Timeline (Ereignisse) und auf der Wissen-Seite (Notizen und andere Einträge) lassen sich mehrere Einträge ankreuzen. „Zuordnen“ setzt für alle auf einmal Thema, Projekt, Tag und Vorgang: Ein Thema oder Projekt wird ergänzt – wer noch keins hat, bekommt es als Hauptthema bzw. -projekt, die anderen als weiteres. Die ganze Sammelaktion ist **ein** Rückgängig-Schritt. Bei Dokumenten bietet der Dialog zusätzlich „Thema entfernen“, „Projekt entfernen“, Schlagwörter entfernen und „Verschieben“.

**Wiki-Links in Notizen**: `[[Name]]` (oder `[[Name|angezeigter Text]]`) verweist auf einen anderen Eintrag – Notiz, Dokument, Entscheidung, offener Punkt, Ereignis, Vorgang, Projekt, Thema, Person oder Tag, auch über Aliasse. Nach `[[` bietet das Textfeld passende Einträge an (Pfeiltasten, Enter). Beim Speichern entsteht je Link eine bestätigte, manuelle Beziehung (Methode `wikilink`, Beleg „[[Name]]“); ein gelöschter Link entfernt sie wieder, Rückgängig der Bearbeitung stellt sie her. Umbenennen oder Zusammenführen des Ziels bricht keinen Link. Unbekannte Namen stehen unter dem Textfeld, mit „als Notiz anlegen“; in der Anzeige sind sie gestrichelt unterstrichen, bekannte Links führen zum Eintrag.

**Rückwirkender Lauf** (Job `links.run`): wendet alle Methoden auf das vorhandene Archiv an, abbrechbar, mit Fortschritt; nach einem Neustart geht er hinter dem letzten vollständig erledigten Eintrag weiter, nichts wird doppelt bezahlt. Er startet einmal nach dem Update und auf Knopfdruck unter Einstellungen → Agent → Agentenläufe; am Ende ein gebündelter Hinweis.

## Personen und eigene Identität

**Neue Personen-Erwähnungen** werden zentral aufgelöst: exakter Name → Alias → Name ohne Rolle/Titel. Groß-/Kleinschreibung, Bindestrich, ü/ue und „Nachname, Vorname“ sind egal.

- Rollen wie „(Chefin)“ landen als Info an der Person.
- Pronomen und Antwortwörter („ich“, „ja“, „unbekannt“) werden nie als Person angelegt.
- Mehrdeutige Kurzformen („Monika“) werden nicht still zugeordnet.

**Eindeutige Dubletten** (gleicher Name ohne Rolle, Titel, Groß-/Kleinschreibung, Bindestrich, Umlaut-Schreibweise und Reihenfolge „Nachname, Vorname“) führt die Archivprüfung automatisch zusammen – abschaltbar unter Einstellungen → Archiv → „Personen-Dubletten automatisch zusammenführen“.

- Der Name wird die sauberste Schreibweise, Rollen landen an der Person, alte Schreibweisen bleiben Aliasse, alle Verweise werden umgehängt.
- Pro Lauf meldet ein Hinweis „N Einträge zu … zusammengeführt“ mit **Rückgängig**. Eine rückgängig gemachte Gruppe wird nie wieder automatisch zusammengeführt.

**Unklare Fälle** (nur Vor- oder Nachname, Initiale, zweiter Vorname, ähnliche Schreibweise) werden nicht geraten, sondern als Frage gestellt: „Ist ‚Monika‘ dieselbe Person wie ‚Monika Lor-Zade‘?“ – mit Belegen (gemeinsame Dokumente, Entscheidungen, Themen).

- **Gleich** führt zusammen (rückgängig machbar, Schreibweise als Alias).
- **Verschieden** wird dauerhaft gemerkt, auch nach Umbenennungen.
- Bei mehreren Kandidaten: „Welche Monika ist gemeint?“ mit „Keine davon“.
- Im Datenschutzmodus `auto` gibt das LLM einen unverbindlichen Hinweis (nur Namen).

**Eigene Identität**: Genau eine Person ist „du“ (Badge **Du** auf der Wissen-Seite). Sie trägt den Namen aus Einstellungen → Über dich bzw. dem Einrichtungsdialog; ohne Namen den Platzhalter „Ich“, der beim Eintragen umbenannt oder mit einer vorhandenen Person dieses Namens zusammengeführt wird.

- Im Chat meinen „ich/mir/mich/mein …“ dich, in Dokumenten meint „ich“ den Verfasser.
- Dein Name, Spitznamen und andere Schreibweisen davon werden dir zugeordnet.
- Die Archivprüfung führt vorhandene Einträge mit deinem Namen, Spitznamen oder „ich“ mit dir zusammen.

## Suche

Hybrid: FTS5-Stichwortsuche + Vektorähnlichkeit (Cosine, im Worker-Thread), per Reciprocal Rank Fusion fusioniert. Warum so: [Wie die Suche funktioniert](../explanation/suche.md).

**Stichwortsuche**

- Frage- und Füllwörter zählen nicht.
- Suchbegriffe werden leicht gestemmt (deutsche/englische Endungen) und als Präfix gesucht: „Entscheidungen“ findet auch „entscheiden“. Komposita werden nicht zerlegt.
- Treffer mit mehr verschiedenen Suchbegriffen stehen vorn (AND- und OR-Abfrage, danach BM25); gezählt wird je Eintrag (bester Abschnitt), nicht je Abschnitt.

**Vektorsuche**

- Lokale Hash-Vektoren sind lexikalisch und stimmen nicht mit ab – sie ergänzen nur Einträge, die die Stichwortsuche nicht gefunden hat.
- Echte Embeddings (falls konfiguriert) stimmen mit ab.
- Im Datenschutzmodus `confirm` nutzen Suchindex und Suchanfragen ausschließlich lokale Vektoren. Antwortet der Embedding-Endpunkt nicht innerhalb von 2,5 s, liefert die Suche die lokalen Treffer.

## Verzeichnisscan

- Nur ausdrücklich freigegebene Ordner.
- Zweistufig: 1. technischer Scan ohne LLM, 2. Analyse nur für neue, geänderte oder ausgewählte Dateien.
- Ausschlüsse; Auslösung manuell, beim Start oder periodisch (nur bei laufender App).
- Die lokale Dokumentensuche ist **standardmäßig deaktiviert**.
- Wird eine Archivierung rückgängig gemacht, kehrt die Scan-Datei in die Zuordnungsvorschläge zurück.

Grenzen und Schutzregeln: [Aktionsstufen und Schutzregeln – Scans](aktionsstufen.md#scans).

## Archivprüfung (Konsistenzschleife)

Die Archivprüfung läuft beim Start (Einstellungen → Archiv → „Beim Start prüfen“) und im eingestellten Intervall („Prüfung alle … Stunden“, 0 = nur beim Start / manuell). Der Zeitpunkt der letzten Prüfung wird in der Tabelle `app_state` gespeichert; das Intervall gilt deshalb über Neustarts hinweg. Nach dem Start wird nur geprüft, wenn das Intervall seit dem letzten Lauf abgelaufen ist – oder genau einmal, wenn „Beim Start prüfen“ eingeschaltet ist.

**Befunde**

- fehlende Zuordnungen, Duplikate,
- **Dokumente zum selben Thema in verschiedenen Verzeichnissen** (mit Umlager-Vorschlag),
- Widersprüche (zurückhaltend, siehe [Grenzen](../explanation/grenzen.md)),
- unvollständige oder überholte Entscheidungen,
- überfällige oder verwaiste offene Punkte (Einstellungen → Archiv → „Offene Punkte gelten als vergessen nach … Tagen“),
- **doppelte offene Punkte** (Titel, Beschreibung, Thema/Projekt, Verantwortlicher),
- **doppelte Notizen** (gleicher oder nahezu gleicher Inhalt – Notizen, die nur gleich beginnen, bleiben getrennt),
- **doppelte Ereignisse** (gleiches Datum, ähnlicher Titel),
- **mögliche Dubletten bei Themen, Projekten und Tags** (Schreibvarianten, Singular/Plural, Tippfehler; „Urlaub“ ↔ „Urlaub 2026“ nur als Frage),
- **gleicher Name als Thema und als Projekt** (Rückfrage „Projekt“ / „Thema“ / „Beides ist richtig“),
- Ablageort vs. Klassifikation, Datenbank vs. Dateisystem,
- [Personen-Dubletten](#personen-und-eigene-identität),
- **Neue Themen aus Gruppen**: Mindestens drei ähnliche Einträge ohne Thema und Projekt werden als „Neues Thema ‚…‘ anlegen?“ vorgeschlagen, mit den Einträgen als Beleg. Den Namen schlägt im Datenschutzmodus „automatisch“ das LLM vor (nur Titel freigegebener Einträge), sonst bilden ihn die häufigsten gemeinsamen Wörter. „Ja“ legt das Thema an und ordnet zu (rückgängig machbar), „Nein“ wird gemerkt. Auch der rückwirkende Verknüpfungslauf schlägt so Themen vor.
- **Einträge ohne Verknüpfung** (Dokumente, Notizen, Entscheidungen, offene Punkte, Ereignisse ohne bestätigte oder vorgeschlagene Beziehung; ein Ordner allein zählt nicht): Je Lauf schlägt die Prüfung für bis zu 50 davon je zwei Ziele vor (ähnliche Einträge, genannte Themen und Projekte) – beim nächsten Lauf geht es mit den nächsten weiter. Ein gebündelter Hinweis führt in die Verknüpfungsvorschläge und schließt sich, sobald jeder dieser Einträge eine bestätigte Verknüpfung hat. Mit ausgeschalteten automatischen Vorschlägen meldet sie nur.

**Doppelte offene Punkte, Notizen und Ereignisse** folgen demselben Muster: Ein Eintrag wird behalten, fehlende Angaben, Quellen, Erinnerungen und Verknüpfungen werden übernommen, der andere wird als „verworfen (Duplikat)“ markiert. Nichts wird gelöscht, alles ist rückgängig machbar, „Verschieden“ wird gemerkt. Auch der Chat fragt vor dem Anlegen eines offenen Punkts nach, wenn es schon einen ähnlichen gibt.

**Dubletten bei Themen, Projekten und Tags** und **Thema ↔ Projekt** werden mit Belegen gefragt. Einen optionalen LLM-Hinweis gibt es nur im Datenschutzmodus `auto`. Zusammenführen ist rückgängig machbar, „Verschieden“ wird dauerhaft gemerkt.

**Hinweise bleiben aktuell**

- Ein Hinweis je Objekt und Art.
- Entfällt die Ursache, schließt der nächste Lauf den Hinweis und zieht seinen Vorschlag zurück (Status „Nicht mehr aktuell“).
- Widerspruch, Hinweis und Ersetzen-Vorschlag werden gemeinsam geschlossen.
- Ein Vorschlag wird vor dem Ausführen erneut geprüft (z. B. nichts zurückschieben, was inzwischen verschoben wurde); nach einem Fehlschlag lässt er sich erneut bestätigen.
- Bestätigte Hinweise kommen wieder, wenn neue Objekte betroffen sind oder die Ursache nach 7 Tagen noch besteht.
- Vorschläge der Archivprüfung lassen sich nur über Insights bzw. Benachrichtigungen ausführen, nicht per „ja“ im Chat.

**Benachrichtigt wird nur bei neuen Befunden** (Hinweise, die vor dem Lauf nicht offen waren). Den Abschluss jeder Prüfung mit kurzer Zusammenfassung zeigt der Job-Verlauf (Einstellungen → Verarbeitung).

## Timeline, Erinnerungen, Benachrichtigungen

- Die **Timeline** zeigt nach dem Filtern die **neuesten** Einträge; ältere über „Ältere laden“, im Chat die neuesten 300.
- Sie zeigt auch **Ereignisse** (per Chat oder „Ereignis hinzufügen“ erfasst, durchsuchbar, im Wissensgraph). Titel, Datum, Beschreibung, Thema und Projekt lassen sich dort bearbeiten, rückgängig machbar im Änderungsprotokoll. Ereignisse lassen sich nach Bestätigung löschen; auch das ist rückgängig machbar.
- **Erinnerungen** werden beim Start geprüft und zeitgesteuert ausgelöst, **solange die App läuft**.
- Anstehende Erinnerungen stehen unter „Offene Punkte“ und in der Notification Bell und lassen sich dort **verschieben** oder **verwerfen**.
- Eine Erinnerung für einen Tag ohne Uhrzeit erscheint um **08:00 Uhr Ortszeit** (Einstellungen → Benachrichtigungen → „Uhrzeit für Erinnerungen“).
- „Heute fällig“, „überfällig“ und die Tage der Timeline richten sich nach der **Ortszeit**, nicht nach UTC.
- Desktop-Benachrichtigungen: Einstellungen → Benachrichtigungen. Sie erscheinen nur, wenn die App-ID stimmt, siehe [Packaging – App-ID](packaging.md#app-id).

## Job-Queue

- Persistent in SQLite, überlebt Neustarts; Fortschritt und Wiederholen.
- Vorübergehende Fehler werden mit zunehmender Wartezeit erneut versucht; Fehlermeldungen erst nach dem letzten Versuch.
- Abbrechen wirkt auch bei Analyse und Archivprüfung (Status „abgebrochen“).
- Beim Beenden werden laufende Jobs unterbrochen und nach dem nächsten Start fortgesetzt. Das Beenden dauert höchstens etwa 10 Sekunden; ein erneuter Start währenddessen öffnet die Anwendung danach wieder.
- Nach einem Absturz läuft ein Job höchstens noch einmal; ohne verbleibende Versuche schlägt er fehl, statt bei jedem Start erneut abzustürzen.
- Stapel-Analysen setzen nach Absturz oder Beenden hinter den bereits erledigten Dateien fort.
- Ein Scan desselben Ordners bzw. eine Archivprüfung wird nicht doppelt eingereiht.
- Abgeschlossene Jobs werden nach 30 Tagen entfernt.
- Schwere Arbeit läuft in Worker-Threads.
- Einsehbar unter Einstellungen → Verarbeitung.

## Änderungsprotokoll und Undo

- Jede relevante Änderung wird protokolliert (Einstellungen → Änderungsprotokoll).
- Undo prüft vorher, ob seitdem etwas verändert wurde, und nimmt nur zurück, was die Aktion selbst getan hat.
- Beziehungen im Wissensgraph, die schon vorher bestanden (auch von dir bestätigte oder abgelehnte), bleiben erhalten; geänderte erhalten ihren vorherigen Status und ihre vorherige Confidence.
- Undo löscht nie die einzige Kopie einer Datei, siehe [Aktionsstufen](aktionsstufen.md#stufen).

## Backups

- Konsistenter SQLite-Snapshot (Online-Backup-API) + Einstellungen ohne API-Key.
- Zwei Arten: Metadaten-Backup und vollständiges Archiv-Backup.
- Ein vollständiges Backup schlägt fehl, wenn der Archivordner nicht erreichbar oder trotz archivierter Dokumente leer ist, und sperrt Archiv-Dateioperationen während der Kopie.
- Das Manifest (mit Dateizahl) wird zuletzt geschrieben; abgebrochene Backups zählen nie.
- Nur nach einem erfolgreichen Backup werden die ältesten über „Anzahl aufbewahrter Backups“ hinaus entfernt (getrennt je Art).

Bedienung: [Backups anlegen](../how-to/backups-anlegen.md).

## OCR

- Eingebaut und standardmäßig aktiv (Einstellungen → Archiv → „Texterkennung in Bildern (OCR)“).
- Bilder (PNG/JPG) und PDFs ohne Textebene (Scans) werden lokal mit `tesseract.js` erkannt. Worker, WASM-Kern und Sprachdaten (Deutsch + Englisch, Pakete `@tesseract.js-data/*`) liegen im Installationspaket – es wird **nichts aus dem Netz geladen**.
- Die Sprachdaten werden beim ersten Einsatz nach `index/tessdata/` kopiert. Weitere Sprachen über `ocr.languages` (z. B. `deu+eng` oder `deu+chi_sim`); das Paket `@tesseract.js-data/<code>` muss installiert sein.
- Bilder werden vor der Erkennung gedreht, kontrastiert und ggf. vergrößert; PDFs werden seitenweise gerendert (max. 40 Seiten).
- Bei Fehlern wird der Grund sichtbar gemeldet und die Datei bleibt trotzdem archivierbar.
