# Archivist

***Archivist – dein persönlicher Archivar***

**Archivist ist ein persönlicher, agentischer AI-Archivar für genau einen Benutzer** – eine lokal installierbare Desktop-Anwendung (Electron + Next.js + TypeScript), die Dokumente, Entscheidungen, offene Punkte und Wissen nicht nur speichert, sondern versteht, verknüpft und das Archiv aktiv konsistent hält.

> ARCHIVIST SPEICHERT WISSEN NICHT NUR. ARCHIVIST FINDET VERSTREUTES WISSEN, VERSTEHT SEINEN KONTEXT UND HÄLT DAS ARCHIV AKTIV KONSISTENT.

Alles ist ausschließlich JavaScript/TypeScript – **kein Python, kein HTTP-Backend, keine Datenbankinstallation, kein Docker**. Alle Daten (Metadaten, Embeddings, Logs, Dateien) liegen lokal; Cloud-Zugriffe gibt es nur für den von dir konfigurierten LLM-Endpunkt.

## Inhalt

- [Funktionsumfang](#funktionsumfang)
- [Schnellstart](#schnellstart)
- [Architektur](#architektur)
- [Projektstruktur](#projektstruktur)
- [Datenhaltung und Dateiablage](#datenhaltung-und-dateiablage)
- [Sicherheits- und Datenschutzmodell](#sicherheits--und-datenschutzmodell)
- [LLM-Anbindung](#llm-anbindung)
- [Agentenmodus](#agentenmodus)
- [Entwicklung, Tests, Build](#entwicklung-tests-build)
- [Evaluation des Agenten](#evaluation-des-agenten)
- [Packaging](#packaging)
- [Bewusste Abweichungen und ehrliche Grenzen](#bewusste-abweichungen-und-ehrliche-grenzen)
- [Fehlerbehebung](#fehlerbehebung)

## Funktionsumfang

| Bereich | Umsetzung |
| --- | --- |
| **Chat** (zentrale Schnittstelle) | LLM-gestützte Intent-Erkennung (strukturiert, Zod-validiert) für Entscheidungen, Notizen, Wissensfragen, Dokumentsuche, Timeline, offene Punkte, Erinnerungen, Archivierung, Scan, Ausschlüsse, Widersprüche; **mehrere Absichten pro Nachricht** (werden nacheinander ausgeführt, Rückfragen stellen die übrigen zurück; legt eine Nachricht mehrere offene Punkte an, gilt die Antwort auf „Bis wann?“ bzw. „Wer ist verantwortlich?“ für alle – „für alle drei 31.12.2026“ –, außer sie nennt einzelne Punkte); das LLM kennt dazu die aktiven offenen Punkte, Entscheidungen, offenen Vorschläge des Gesprächs (nur Titel und Metadaten, mit IDs) und deinen Namen (Einstellungen → Über dich); Rückfrage statt Raten bei unklarer Absicht und **bevor eine unsichere „Entscheidung“ gespeichert wird** (Entscheidung / Ereignis / Notiz / nichts speichern); **Ereignisse** („am 01.10.2026 eingereicht“) landen mit Datum in der Timeline; Antworten mit Quellen, getrennten Fakten/Interpretation und sichtbaren Unsicherheiten; eine laufende Anfrage lässt sich **abbrechen** (Erledigtes bleibt, der Rest entfällt); nach einer Zeitüberschreitung oder einem unerreichbaren Endpunkt scheitern LLM-Anfragen 60 s lang sofort, statt erneut zu warten (der Verbindungstest geht immer durch) |
| **Decision Tracking** | Pflichtfelder *Wann, Thema, Beteiligte, Entscheidung*; gezielte Rückfragen; Entwurf, bis alles vollständig ist oder ausdrücklich als „unbekannt“ bestätigt wurde; Ersetzen/Widerrufen nur nach Bestätigung (auch aus dem Formular) und rückgängig machbar |
| **Dokumente** | Drag-and-Drop/Dateiauswahl, sicherer Eingang (`inbox/`), Prüfsumme, Duplikaterkennung, Parser für PDF, DOCX, PPTX, XLSX, EML, TXT/MD, PNG/JPG, Klassifikation (LLM oder lokal), menschenlesbarer Zielpfad, Archivierung per Kopieren/Verschieben/nur Indexieren/Ignorieren, Undo; ändert sich das Original eines nur indexierten Dokuments, wird es beim nächsten Scan bzw. bei der Archivprüfung (andere Dateigröße) lokal neu eingelesen und neu indexiert – kein zweites Dokument, kein veralteter Inhalt in der Suche; fehlt das Original, meldet die Archivprüfung „Original fehlt“; wird das Original eines archivierten Dokuments geändert und neu analysiert, wird das neue Dokument als Ersatz („ersetzt“, Vorschlag) des archivierten verknüpft |
| **Wissensgraph** | Entitäten (Document, Decision, Topic, Project, Person, Event, Question→Task, Note, Category, Tag) und Beziehungen mit Confidence/Status (`proposed/confirmed/rejected/outdated`) in SQLite; **Zusammenführen** von Themen, Projekten (auch Thema ↔ Projekt), Personen und Tags hängt Beziehungen, Thema/Projekt-Verweise (Dokumente, Entscheidungen, offene Punkte, Ereignisse), Beteiligte, Personen und Verantwortliche um, merkt alte Namen als Aliasse, indexiert neu und lässt sich – auch mehrere Zusammenführungen eines Laufs auf einmal – exakt rückgängig machen; ändern sich Thema, Projekt, Beteiligte, Personen oder Tags (auch beim Bearbeiten eines archivierten Dokuments) oder der Verantwortliche eines offenen Punkts, werden die automatisch angelegten Beziehungen zum alten Ziel `outdated` (von dir bestätigte oder abgelehnte bleiben unverändert, Rückgängig stellt sie wieder her); Verantwortliche sind als Beziehung „verantwortlich für“ mit ihrem offenen Punkt verbunden; Ereignisse haben Beteiligte (Dialog, Chat, Graph „beteiligt an“); beim Archivieren werden alle Personen und Tags verknüpft (nicht mehr nur 12 bzw. 8); „Neu anlegen“ auf der Wissen-Seite erzeugt echte Einträge (Ereignisse mit Datum über den Timeline-Dialog, Notizen indexiert) und öffnet bei einem bereits vorhandenen Eintrag diesen mit dem Hinweis „existiert bereits“; neue **Personen-Erwähnungen** werden zentral aufgelöst (exakter Name → Alias → Name ohne Rolle/Titel, Groß-/Kleinschreibung, Bindestrich, ü/ue und „Nachname, Vorname“ egal), Rollen wie „(Chefin)“ landen als Info an der Person, Pronomen und Antwortwörter („ich“, „ja“, „unbekannt“) werden nie als Person angelegt und mehrdeutige Kurzformen („Monika“) nicht still zugeordnet; **eindeutige Personen-Dubletten** (gleicher Name ohne Rolle, Titel, Groß-/Kleinschreibung, Bindestrich, Umlaut-Schreibweise und Reihenfolge „Nachname, Vorname“) führt die Archivprüfung automatisch zusammen (abschaltbar unter Einstellungen → Archiv): Name wird die sauberste Schreibweise, Rollen landen an der Person, alte Schreibweisen bleiben Aliasse, alle Verweise werden umgehängt; pro Lauf meldet ein Hinweis „N Einträge zu … zusammengeführt“ mit **Rückgängig** – eine rückgängig gemachte Gruppe wird nie wieder automatisch zusammengeführt; **unklare Fälle** (nur Vor- oder Nachname, Initiale, zweiter Vorname, ähnliche Schreibweise) werden nicht geraten, sondern als Frage gestellt („Ist ‚Monika‘ dieselbe Person wie ‚Monika Lor-Zade‘?“ mit Belegen: gemeinsame Dokumente, Entscheidungen, Themen): **Gleich** führt zusammen (rückgängig machbar, Schreibweise als Alias), **Verschieden** wird dauerhaft gemerkt (auch nach Umbenennungen), bei mehreren Kandidaten gibt es eine Frage „Welche Monika ist gemeint?“ mit „Keine davon“; im Datenschutzmodus „automatisch“ gibt das LLM einen unverbindlichen Hinweis (nur Namen); **eigene Identität**: genau eine Person ist „du“ (Badge **Du** auf der Wissen-Seite) und trägt den Namen aus Einstellungen → Über dich bzw. dem Einrichtungsdialog (ohne Namen den Platzhalter „Ich“, der beim Eintragen umbenannt oder mit einer vorhandenen Person dieses Namens zusammengeführt wird); im Chat meinen „ich/mir/mich/mein …“ dich, in Dokumenten meint „ich“ den Verfasser; dein Name, Spitznamen und andere Schreibweisen davon werden dir zugeordnet, und die Archivprüfung führt vorhandene Einträge mit deinem Namen, Spitznamen oder „ich“ mit dir zusammen |
| **Suche** | Hybrid: FTS5 + Vektorähnlichkeit (Cosine, im Worker-Thread), per Reciprocal Rank Fusion fusioniert. Stichwortsuche: Frage- und Füllwörter zählen nicht; Suchbegriffe werden leicht gestemmt (deutsche/englische Endungen) und als Präfix gesucht, sodass „Entscheidungen“ auch „entscheiden“ findet (keine Zerlegung von Komposita); Treffer mit mehr verschiedenen Suchbegriffen stehen vorn (AND- und OR-Abfrage, danach BM25), gezählt wird je Eintrag (bester Abschnitt), nicht je Abschnitt. Die lokalen Hash-Vektoren sind lexikalisch und stimmen nicht mit ab – sie ergänzen nur Einträge, die die Stichwortsuche nicht gefunden hat; echte Embeddings (falls konfiguriert) stimmen mit ab |
| **Verzeichnisscan** | Nur ausdrücklich freigegebene Ordner, zweistufig (1. technischer Scan ohne LLM, 2. Analyse nur für neue/geänderte/ausgewählte Dateien), Ausschlüsse, manuell / beim Start / periodisch (nur bei laufender App) |
| **Agentische Konsistenzschleife** | Archivprüfung: fehlende Zuordnungen, Duplikate, **Dokumente zum selben Thema in verschiedenen Verzeichnissen (mit Umlager-Vorschlag)**, Widersprüche, unvollständige/überholte Entscheidungen, überfällige/verwaiste offene Punkte, **doppelte offene Punkte** (Titel, Beschreibung, Thema/Projekt, Verantwortlicher; Vorschlag: einen behalten, fehlende Angaben, Quellen und Erinnerungen übernehmen, den anderen als „verworfen (Duplikat)“ markieren – nichts wird gelöscht, rückgängig machbar, „Verschieden“ wird gemerkt; auch der Chat fragt vor dem Anlegen nach), **doppelte Notizen** (gleicher oder nahezu gleicher Inhalt – Notizen, die nur gleich beginnen, bleiben getrennt) und **doppelte Ereignisse** (gleiches Datum, ähnlicher Titel; gleiches Muster: einen Eintrag behalten, fehlende Angaben und Verknüpfungen übernehmen, den anderen als „verworfen (Duplikat)“ markieren – nichts wird gelöscht, rückgängig machbar, „Verschieden“ wird gemerkt), **mögliche Dubletten bei Themen, Projekten und Tags** (Schreibvarianten, Singular/Plural, Tippfehler, „Urlaub“ ↔ „Urlaub 2026“ nur als Frage; mit Belegen, optionalem LLM-Hinweis nur im Datenschutzmodus „Automatisch analysieren“ und rückgängig machbarem Zusammenführen – „Verschieden“ wird dauerhaft gemerkt), **gleicher Name als Thema und als Projekt (Rückfrage „Projekt“ / „Thema“ / „Beides ist richtig“; Zusammenführen rückgängig machbar, „verschieden“ wird dauerhaft gemerkt)**, Ablageort vs. Klassifikation, DB-vs-Dateisystem. **Hinweise bleiben aktuell:** ein Hinweis je Objekt und Art; entfällt die Ursache, schließt der nächste Lauf den Hinweis und zieht seinen Vorschlag zurück (Status „Nicht mehr aktuell“); Widerspruch, Hinweis und Ersetzen-Vorschlag werden gemeinsam geschlossen; ein Vorschlag wird vor dem Ausführen erneut geprüft (z. B. nichts zurückschieben, was inzwischen verschoben wurde); nach einem Fehlschlag lässt er sich erneut bestätigen; bestätigte Hinweise kommen wieder, wenn neue Objekte betroffen sind oder die Ursache nach 7 Tagen noch besteht. **Benachrichtigt wird nur bei neuen Befunden** (Hinweise, die vor dem Lauf nicht offen waren); den Abschluss jeder Prüfung mit kurzer Zusammenfassung zeigt der Job-Verlauf (Einstellungen → Verarbeitung) |
| **Insights, Timeline, Notification Bell, Erinnerungen** | siehe UI; die Timeline zeigt nach dem Filtern die **neuesten** Einträge (ältere über „Ältere laden“; im Chat die neuesten 300) und auch **Ereignisse** (per Chat oder „Ereignis hinzufügen“ erfasst, durchsuchbar, im Wissensgraph; Titel, Datum, Beschreibung, Thema und Projekt lassen sich dort bearbeiten, rückgängig machbar im Änderungsprotokoll); Erinnerungen werden beim Start geprüft und zeitgesteuert ausgelöst, **solange die App läuft**; anstehende Erinnerungen stehen unter „Offene Punkte“ und in der Notification Bell und lassen sich dort **verschieben** oder **verwerfen**; eine Erinnerung für einen Tag ohne Uhrzeit erscheint um **08:00 Uhr Ortszeit** (Einstellungen → Benachrichtigungen); „heute fällig“, „überfällig“ und die Tage der Timeline richten sich nach der **Ortszeit**, nicht nach UTC |
| **Job-Queue** | Persistent in SQLite, überlebt Neustarts, Fortschritt, Wiederholen; vorübergehende Fehler werden mit zunehmender Wartezeit erneut versucht, Fehlermeldungen erst nach dem letzten Versuch; Abbrechen wirkt auch bei Analyse und Archivprüfung (Status „abgebrochen“); beim Beenden werden laufende Jobs unterbrochen und nach dem nächsten Start fortgesetzt – das Beenden dauert höchstens etwa 10 Sekunden, ein erneuter Start währenddessen öffnet die Anwendung danach wieder; nach einem Absturz läuft ein Job höchstens noch einmal (ohne verbleibende Versuche schlägt er fehl, statt bei jedem Start erneut abzustürzen); Stapel-Analysen setzen nach Absturz oder Beenden hinter den bereits erledigten Dateien fort; ein Scan desselben Ordners bzw. eine Archivprüfung wird nicht doppelt eingereiht; abgeschlossene Jobs werden nach 30 Tagen entfernt; schwere Arbeit in Worker-Threads |
| **Audit Log + Undo** | Jede relevante Änderung wird protokolliert; Undo prüft vorher, ob seitdem etwas verändert wurde, und nimmt nur zurück, was die Aktion selbst getan hat: Beziehungen im Wissensgraph, die schon vorher bestanden (auch von dir bestätigte oder abgelehnte), bleiben erhalten, geänderte erhalten ihren vorherigen Status und ihre vorherige Confidence |
| **Backups** | Konsistenter SQLite-Snapshot (Online-Backup-API) + Einstellungen ohne API-Key; Metadaten- vs. vollständiges Archiv-Backup; ein vollständiges Backup schlägt fehl, wenn der Archivordner nicht erreichbar oder trotz archivierter Dokumente leer ist, und sperrt Archiv-Dateioperationen während der Kopie; das Manifest (mit Dateizahl) wird zuletzt geschrieben, abgebrochene Backups zählen nie; nur nach einem erfolgreichen Backup werden die ältesten über „Anzahl aufbewahrter Backups“ hinaus entfernt (getrennt je Art) |

### Bedienung in Kürze

1. Beim ersten Start führt ein Einrichtungsdialog durch LLM-Verbindung (Base URL, API-Key, Modell, Verbindungstest), optionale Scan-Verzeichnisse und den Datenschutzmodus.
2. Datei in das Fenster ziehen → Archivist kopiert sie in den Eingang, extrahiert Text, schlägt Kategorie/Zielordner vor → in der **Inbox** Quell- und Zielpfad prüfen → bestätigen.
3. Im **Chat** Entscheidungen mitteilen („Wir haben entschieden, dass wir mit prod-plat erstmal nicht weitermachen.“); Archivist fragt nach Datum, Beteiligten und Thema und speichert erst dann final.
4. Später fragen: „Wann haben wir prod-plat pausiert?“ – Antwort mit Quellen.
   - **Ablage prüfen:** „Sind meine Dateien konsistent?“, „In welchen Verzeichnissen liegen die Dokumente zu Bildungsurlaub 2026?“ – Archivist zeigt, in welchen Verzeichnissen die Dokumente eines Themas oder Projekts liegen, und weist auf verstreute Ablage hin.
   - **Umlagern:** „Können die nicht alle ins selbe Verzeichnis?“ (optional mit Zielordner) – Archivist schlägt als Ziel den Ordner vor, in dem schon die meisten liegen, und bereitet das Verschieben als Aktionskarte vor. Erst nach „ja“ bzw. Bestätigung wird verschoben: nichts wird überschrieben (bei gleichem Namen `Name (2).ext`), geänderte Dateien bleiben liegen, leere Ordner werden aufgeräumt, und das Protokoll bietet **Rückgängig**. Abgelehnte Kategorie-Zuordnungen bleiben beim Umlagern bestehen. Rückgängig stellt die Zuordnungen exakt wieder her (samt Status); danach lässt sich auch die Archivierung selbst noch rückgängig machen.
5. Unter **Scan** ein Verzeichnis freigeben (z. B. `~/Downloads`), „Jetzt suchen“, Dateien auswählen, analysieren, Zuordnungsvorschläge bestätigen.

## Schnellstart

**Plattform**: Archivist wird nur für **Windows** gebaut, getestet und gepflegt (NSIS-Installer und portable EXE). Die Entwicklung mit `npm run dev` funktioniert in der Regel auch unter anderen Betriebssystemen, wird dort aber nicht zugesichert.

Voraussetzungen für die **Entwicklung**: Node.js ≥ 22, npm ≥ 10. Endbenutzer brauchen nur den Installer.

```bash
npm install            # installiert alle Workspaces (inkl. Electron)
npm run dev            # Next.js-Dev-Server + Electron mit Hot Reload
# oder:
npm run build && npm run start --workspace archivist   # gebündelte App starten
```

Tests und Qualität:

```bash
npm run typecheck      # tsc strict in allen Workspaces + Tests
npm run lint           # ESLint (typescript-eslint)
npm test               # Vitest: Unit- und Integrationstests
npm run native:check   # prüft die nativen Module in Node UND in der Electron-Laufzeit
npm run test:e2e       # Playwright (Electron); in der CI (Ubuntu) headless: xvfb-run -a npm run test:e2e
```

Der E2E-Test lässt sich auch gegen die **gepackte** App ausführen:
`npm run pack -w archivist && ARCHIVIST_E2E_PACKAGED=1 xvfb-run -a npx playwright test`.

## Architektur

```
┌────────────────────────── Electron ───────────────────────────┐
│  Renderer (Next.js, statisch exportiert, sandbox, CSP)        │
│    React · Tailwind · shadcn/ui-Stil                          │
│          │  window.archivist.invoke(channel, input)           │
│  Preload (contextBridge, explizite Kanal-Allowlist)           │
│          │  ipcRenderer.invoke  (nur Kanäle des IPC-Vertrags) │
│  Main-Prozess                                                  │
│    · prüft Absender, validiert Ein-/Ausgabe mit Zod            │
│    · delegiert ausschließlich an den Service-Layer             │
│    · Betriebssystem: Dialoge, safeStorage, Notifications       │
│          │                                                     │
│  @archivist/core  (reines TypeScript, ohne Electron-Abhängigkeit)
│    Services · SQLite (better-sqlite3 + Drizzle) · LLM-Client   │
│          │ Aufgaben (Hash, Scan, Parser, Cosine)               │
│  Worker-Threads (Pool)                                         │
└────────────────────────────────────────────────────────────────┘
```

Wichtige Entwurfsentscheidungen:

- **Ein Vertrag für alles:** `packages/shared/src/ipc.ts` definiert für jeden IPC-Kanal Input- *und* Output-Schema (Zod). Renderer-Typen, Preload-Allowlist, Main-Validierung und Tests leiten sich daraus ab. Fehler kommen immer als `Result` mit Kategorie (`validation_error`, `database_error`, `filesystem_error`, `parser_error`, `llm_error`, `network_error`, `permission_error`, `scan_error`, `archive_conflict`, `native_module_error`).
- **Service-Layer ohne Electron:** `@archivist/core` kennt weder Electron noch HTTP. Die gesamte Geschäftslogik ist dadurch mit Vitest gegen eine echte SQLite-Datenbank und einen Fake-LLM-Endpunkt testbar. Electron-spezifisches (safeStorage, Dialoge, `shell`) wird über kleine Schnittstellen (`SecretCipher`, `HostApi`) injiziert.
- **Main-Prozess bleibt frei:** Datenbankzugriffe sind kurz (synchrones better-sqlite3); lange Lesezugriffe (Timeline, Dokumentliste, Zähler) laufen in einem eigenen Lese-Worker mit eigener schreibgeschützter Verbindung (WAL); Hashing, Verzeichnisscans, Textextraktion und Vektorsuche laufen im Worker-Pool; die Archivprüfung gibt den Main-Thread zwischen ihren Schritten und in langen Schleifen frei; langlaufende Abläufe sind Jobs in der persistenten Queue.
- **Kritisches nur mit Bestätigung:** Der Agent erzeugt *Vorschläge* (`agent_actions`) mit Begründung, Confidence und betroffenen Objekten. Ausführen kann sie nur `actions:resolve` mit `confirmed: true` – auf IPC-Ebene als `z.literal(true)` erzwungen. Ein „ja“ im Chat bestätigt nur Vorschläge, die **in diesem Gespräch** als Karte angezeigt werden und noch offen sind; sind es mehrere, fragt Archivist nach. Vorschläge der Archivprüfung lassen sich nur über Insights bzw. Benachrichtigungen ausführen.

### Services

`DatabaseService`/Migrationen, `SettingsService`, `SecretService`, `LlmService`, `EmbeddingService`, `SearchService`, `KnowledgeGraphService`, `DocumentService` (+ Parser, Klassifikator), `ArchiveService`, `ScannerService`, `DecisionService`, `OpenItemService`, `EventService`, `ReminderService`, `NotificationService`, `InsightService`, `ContradictionService`, `ConsistencyService`, `TimelineService`, `ActionService`, `ChatService`, `JobQueueService`, `AuditService`, `UndoService`, `BackupService`, `PrivacyService`, `CategoryService`.

## Projektstruktur

```
archivist/
├── apps/
│   ├── desktop/            Electron: main.ts, preload.ts, renderer-server.ts (app://-Protokoll + CSP),
│   │                       scripts/ (esbuild-Build, Dev), electron-builder.yml, build/ (Icon)
│   └── renderer/           Next.js (statischer Export): app/, components/, lib/
├── packages/
│   ├── shared/             Zod-Schemas (Domäne, Einstellungen, LLM-Ausgaben) + IPC-Vertrag
│   └── core/               Service-Layer, Drizzle-Schema + Migrationen (migrations/), Parser, Worker, LLM-Client
├── tests/
│   ├── unit/               Pfade, Datum, Maskierung, Schemas, Parser, Renderer-Auslieferung …
│   ├── integration/        Vertikaler Slice, Chat/Decisions, Scanner, Archivsicherheit, Plattform
│   └── e2e/                Playwright gegen die echte Electron-App (+ Fake-LLM-HTTP-Server)
├── scripts/check-native.mjs
├── config.example.json     Beispielkonfiguration (ohne Zugangsdaten)
└── .env.example            Dokumentierte Umgebungsvariablen (werden nicht automatisch geladen)
```

## Datenhaltung und Dateiablage

Standardmäßig `~/Documents/Archivist/` (überschreibbar mit `ARCHIVIST_DATA_DIR`):

```
Archivist/
├── archive/       archivierte Dateien in menschenlesbaren Ordnern (work/projects/prod-plat/, private/vacation/2026/ …)
├── database/      archivist.db (SQLite, WAL)
├── index/         lokale Indexdaten (z. B. OCR-Sprachdaten)
├── config/        settings.json (nicht geheim) und llm-api-key.enc (verschlüsselt)
├── logs/          strukturierte JSON-Logs (ohne Schlüssel/Dokumentinhalte)
├── backups/       Datenbank- und Metadaten-Backups
├── inbox/         Eingang: eigene Kopien hochgeladener Dateien bis zur Archivierung
└── quarantine/    Dateien, deren Inhalt nicht zur Endung passt (in der Inbox unter „Quarantäne“ sichtbar: „Ordner öffnen“ oder nach Bestätigung „Trotzdem importieren“)
```

- Die Ablage bleibt **auch ohne Archivist verständlich**: keine Hash-/UUID-Ordner, keine reinen Dateityp-Ordner (`pdf/`, `docx/` …). Vorgeschlagene Pfade werden bereinigt; Unterkategorien darf der Agent vorschlagen, **neue Hauptkategorien** (erstes Pfadsegment) nur nach Bestätigung.
- Archivdateien werden relativ zum Archivwurzelpfad referenziert (`archive_rel_path`).
- Enthält `config/settings.json` ungültige Werte, werden nur diese Felder auf ihren Standard gesetzt; alle übrigen Einstellungen bleiben erhalten. Die Originaldatei wird vorher als `settings.json.invalid-<Zeit>` gesichert (ist sie kein gültiges JSON, als `settings.json.corrupt-<Zeit>`), und eine Benachrichtigung nennt die betroffenen Felder.
- Das Schema steht in `packages/core/src/db/schema.ts` (Drizzle). Migrationen (`packages/core/migrations/`) erzeugt `npm run db:generate`; die FTS5-Tabelle ist eine benutzerdefinierte Migration. Beim Start werden Migrationen automatisch angewendet.

## Sicherheits- und Datenschutzmodell

**Aktionsstufen**

| Stufe | Beispiele | Verhalten |
| --- | --- | --- |
| 1 – automatisch | Dateien in freigegebenen Ordnern auflisten, Metadaten/Prüfsummen, Textextraktion, Suchindex, Vorschläge, Insights, Benachrichtigungen | läuft ohne Rückfrage |
| 2 – Bestätigung | Kopieren/Verschieben ins Archiv, **bereits archivierte Dokumente in einen anderen Archivordner verschieben**, Umbenennen, neue Hauptkategorie, Entscheidung als überholt markieren, Widerspruch lösen, offenen Punkt schließen, Metadaten überschreiben, Themen/Einträge zusammenführen (rückgängig machbar) | Aktionskarte / Dialog mit Quell- und Zielpfad, Begründung, Confidence; ohne `confirmed: true` abgelehnt |
| 3 – besonders | Umlagern von 20 oder mehr archivierten Dokumenten auf einmal; Löschen, Überschreiben, automatisches Umsortieren des ganzen Archivs | Umlagern ab 20 Dokumenten: Karte „Besonders folgenreich“, ausgeführt erst nach einer zweiten, ausdrücklichen Bestätigung im Dialog – ein „ja“ im Chat genügt dafür nicht. Löschen, Überschreiben und das Umsortieren des ganzen Archivs sind **nicht implementiert** – Archivist löscht und überschreibt keine Dateien. Einzige Ausnahme beim Löschen sind von Ihnen erfasste **Ereignisse**: Sie lassen sich nach Bestätigung löschen, und das Löschen lässt sich unter Einstellungen → Änderungsprotokoll rückgängig machen (Ereignis mit Thema, Projekt, Verknüpfungen und Suchtreffer; was inzwischen entfernt wurde, nennt die Meldung) (auch Undo löscht nie die einzige Kopie: Als weitere Kopie zählt nur eine Datei mit gleicher Prüfsumme am Quell- bzw. Eingangsort. Fehlt sie, weil das Original seitdem bearbeitet oder entfernt wurde, legt Undo die archivierte Fassung an den Ursprungsort zurück, bei Namenskonflikt als `Name (2).ext`). Umlagern ist nur für ausdrücklich genannte Dokumente möglich und wird immer vorher bestätigt. |

**Dateien**: Originale werden nie ohne ausdrückliche Bestätigung verändert. Standard ist *Kopieren*. Zieldateien werden mit `COPYFILE_EXCL` angelegt (kein Überschreiben, bei Namenskollision `Name (2).ext`), per SHA-256 verifiziert und erst danach werden – nur bei „Verschieben“ und zusätzlicher Bestätigung – Quellen entfernt. Pfade werden gegen Traversal (`..`, absolute Pfade, Nullbytes), Symlink-Ausbruch (realpath-Prüfung) und ungültige Dateinamen (Windows-reservierte Namen, Sonderzeichen) abgesichert; Dateien, die sich seit der Analyse geändert haben, werden nicht archiviert.

**Teilfehler**: Bricht eine Kopie mittendrin ab (z. B. Datenträger voll), wird die Teilkopie entfernt; lässt sie sich nicht entfernen, nennt die Meldung ihren Pfad. Scheitert beim Umlagern das Entfernen der alten Datei (z. B. weil sie geöffnet ist), wird der neue Eintrag zurückgenommen; bleibt er übrig (zusätzlicher Hardlink oder Kopie), steht das in der Meldung statt „nichts wurde verändert“. Lässt sich nach dem Archivieren die eigene Kopie im Eingang nicht löschen, bleibt die Archivierung gültig und rückgängig machbar; die Eingangskopie wird vorgemerkt und beim nächsten Archivieren, bei der Archivprüfung oder beim nächsten Start entfernt (nur, wenn sie unverändert ist und die Archivdatei intakt). Ein Umlager-Vorschlag, bei dem nichts verschoben wurde, gilt als fehlgeschlagen: Der Hinweis bleibt offen und erhält bei der nächsten Archivprüfung einen neuen Vorschlag.

**Scans**: Nur ausdrücklich freigegebene Verzeichnisse; Wurzeln, Systemverzeichnisse und Verzeichnisse anderer Benutzer werden abgelehnt; das Archivist-Datenverzeichnis wird nie gescannt; Symlinks werden nur verfolgt, wenn ihr Ziel im freigegebenen Bereich liegt; versteckte Einträge und `node_modules` werden übersprungen. Bekannte, unveränderte Dateien (Größe + Änderungszeit) werden weder neu gehasht noch analysiert. Dateien, deren Inhalt bereits als Dokument im Eingang oder im Archiv liegt (auch als Upload, in einer anderen Wurzel oder als „x (1).pdf“), werden als Duplikat markiert statt erneut angelegt; ändert sich eine gescannte Datei, deren Dokument noch im Eingang liegt, aktualisiert die nächste Analyse diesen Eintrag. Pro Wurzel werden höchstens 20.000 Dateien erfasst – wird das Limit erreicht, erscheint ein Hinweis, und Dateien hinter dem Limit oder in (vorübergehend) nicht lesbaren Ordnern gelten nicht als verschwunden. Wird eine Archivierung rückgängig gemacht, kehrt die Scan-Datei in die Zuordnungsvorschläge zurück. Die lokale Dokumentensuche ist **standardmäßig deaktiviert**.

**LLM-Datenschutz** (`Einstellungen → Datenschutz`):

- `auto` – Inhalte automatisch analysieren · `confirm` (Standard) – vor jeder externen Analyse ausdrücklich bestätigen · `local_only` – nie extern (keine Klassifikation, keine Chat-Auswertung, keine Embeddings per LLM). Die Auswahl wird sofort gespeichert; der aktive Modus wird darunter angezeigt.
- Verzeichnisse, Dateitypen und einzelne Dateien lassen sich dauerhaft von der LLM-Verarbeitung ausschließen. Ausschlüsse vergleichen auch den realen Pfad (Symlinks/Junctions) und ignorieren unter Windows die Groß-/Kleinschreibung. In der UI sind die Zustände sichtbar: *nur lokal gescannt · zur LLM-Analyse vorgesehen · per LLM analysiert · von externer Analyse ausgeschlossen*.
- Die Freigabe „keine KI-Analyse“ eines Scan-Verzeichnisses wird am Dokument gespeichert (auch für Dateien, die aus diesem Ordner hochgeladen werden) und gilt für Analyse, „Erneut verarbeiten“, Chat-Quellen, Lösungsvorschläge und Embeddings; wird sie später entzogen, gilt das sofort für bereits erfasste Dokumente.
- Im Modus `confirm` fragt auch „Erneut verarbeiten“ vor der Übertragung nach. Chat-Antworten senden nur Dokumente, die zur externen Analyse freigegeben wurden; andere passende Dokumente werden nur lokal als Quelle aufgeführt. Suchindex und Suchanfragen nutzen in diesem Modus ausschließlich lokale Vektoren. Antwortet der Embedding-Endpunkt nicht innerhalb von 2,5 s, liefert die Suche die lokalen Treffer.
- Vor jeder Übertragung werden Zugangsdaten und Geheimnisse (Passwörter – auch in Anführungszeichen mit Leerzeichen –, API-Keys inkl. Google-Keys, Tokens, JWTs, private Schlüssel, Zugangsdaten in URLs sowie Schlüssel und Passwörter in Verbindungsstrings wie `AccountKey=…;`, `SharedAccessKey=…;` oder `Password=…;`) **maskiert**; jede Übertragung wird mit Zeitpunkt, Zweck, Modell, Größe, Anzahl maskierter Stellen und gekürzter, maskierter Vorschau protokolliert und ist unter *Datenschutz → Übertragungsprotokoll* einsehbar. Gesendet wird mit `store: false`. Lehnt ein kompatibler Endpunkt einen optionalen Parameter ab, wird nur genau dieser weggelassen (und für Endpunkt + Modell gemerkt); `store: false` entfällt nur, wenn der Endpunkt `store` selbst ablehnt.

**Electron**: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, kein `eval`, Navigation und `window.open` gesperrt, Berechtigungsanfragen abgelehnt. Das Frontend wird über ein eigenes `app://`-Protokoll ausgeliefert (kein HTTP-Server, kein `file://`) mit strenger CSP (`default-src 'none'`, Skripte nur `self` + SHA-256-Hashes der von Next.js erzeugten Inline-Skripte, `connect-src 'self'`). IPC: explizite Kanal-Allowlist, Absender-Prüfung (Frame-URL + WebContents), Zod-Validierung von Ein- **und** Ausgaben. Der Renderer hat keinen Zugriff auf Node, Dateisystem, Datenbank, Shell oder Credential Store; Dateien öffnet nur der Main-Prozess und nur solche, die Archivist kennt.

**Geheimnisse**: Der API-Key wird ausschließlich über Electron `safeStorage` (Windows DPAPI) verschlüsselt in `config/llm-api-key.enc` abgelegt – nie in `settings.json`, Datenbank, Backups oder Logs (der Logger maskiert bekannte Schlüssel zusätzlich aktiv). Ist kein sicherer Speicher verfügbar, **verweigert** Archivist das Speichern.

## LLM-Anbindung

- Konfigurierbar: Base URL, API-Key, Modellname (nicht im Code verdrahtet), optional reasoning effort, Timeout, maximale Eingabegröße, optionales Embedding-Modell.
- Verwendet wird die OpenAI-kompatible **Responses API** (`POST {baseUrl}/responses`), z. B. `https://<resource>.openai.azure.com/openai/v1`. Authentifizierung wird als `Authorization: Bearer` und `api-key` gesendet.
- Strukturierte Ausgaben: Das JSON-Schema wird aus dem Zod-Schema erzeugt und im Prompt mitgegeben, `text.format = json_object` angefordert (die Eingabe nennt dafür immer das Wort „JSON“, das die Responses API in der Eingabe – nicht in den Instructions – verlangt); die Antwort wird mit Zod validiert. Bei ungültiger Ausgabe genau eine Korrekturanfrage, danach Verwerfen + sichtbarer technischer Fehler. **Ungültige Ausgaben lösen nie Datei- oder Datenbankänderungen aus.**
- Nicht erreichbarer Endpunkt: verständliche Fehlermeldung, Retries bei transienten Fehlern (Netzwerk/429/5xx), Status in der Kopfzeile; der Chat fällt auf eine regelbasierte Auswertung bzw. lokale Trefferlisten zurück und kennzeichnet das deutlich.
- Antworten auf Wissensfragen: Fakten müssen auf tatsächlich bereitgestellte Quellen verweisen – Aussagen mit ungültigem Quellenbeleg werden verworfen und als Unsicherheit ausgewiesen. Bleibt keine belegte Aussage übrig, erscheint die Antwort des Modells nur als „Nicht belegt (Einschätzung des Modells)“, die Sicherheit wird auf höchstens 30 % gesetzt und gefundene, aber nicht zitierte Quellen sind als „gefunden, nicht zitiert“ gekennzeichnet. Zu gefundenen Entscheidungen kommen ihre Quelldokumente mit der passenden Textstelle in den Prompt.
- Schutz vor Anweisungen in Dokumenten (Prompt-Injection): Dokumenttexte, Verlauf und Kontextlisten sind in jedem Prompt als Daten markiert. Vorschläge führt der Chat nur nach einem eindeutigen „ja“ des Benutzers aus, nie auf eine Einordnung des Modells hin. Frühere Antworten aus dem Archiv gehen nicht als Text in die Intent-Erkennung ein. Themen und Projekte, die unverändert aus einem Dokument übernommen wurden, sind auf der Wissen-Seite „unbestätigt“ und werden dem Modell erst nach deiner Bestätigung (oder sobald du den Namen selbst verwendest) als bekannt genannt. Bei reinen HTML-E-Mails fällt für den Leser unsichtbarer Text (display:none, font-size:0, …) aus dem Dokumenttext heraus.

## Agentenmodus

Archivist arbeitet als Agent (Epic #294): Er versteht ein Anliegen, beschafft sich mit Werkzeugen selbst die nötigen Daten, plant mehrere Schritte und führt Änderungen aus – im Chat und im Hintergrund. Ohne LLM, im Modus „nur lokal“ oder bei einem Endpunkt ohne natives Tool-Calling gilt weiter die regelbasierte Auswertung.

- **Kern** (`packages/core/src/agent/`): anbieterneutrale Schleife (`runner.ts`) mit Werkzeug-Register (Name, Beschreibung, Zod-Schema, Risikostufe `read`/`write`/`critical`, Ausführung über dieselben Service-Funktionen wie die Oberfläche). Ungültige Argumente gehen als Fehler-Ergebnis an das Modell zurück; lesende Aufrufe einer Runde laufen parallel; Rückfragen (`ask_user`) sind ein eigener Ausgang, die Antwort setzt den Lauf mit vollem Kontext fort. Statt einer festen Schrittzahl begrenzen Token-Budget, Notbremse für Runden, Zeitlimit, Schleifenerkennung und „Stopp“ den Lauf; an einer Grenze fasst der Agent zusammen, was erledigt ist und was fehlt.
- **Anbieter**: Claude über die Anthropic Messages API mit dem offiziellen SDK (`@anthropic-ai/sdk`, für Microsoft Foundry `@anthropic-ai/foundry-sdk`) und ChatGPT/OpenAI über die Responses API (auch Azure OpenAI bzw. Foundry `…/openai/v1`). Der Adapter wird aus der Base URL erkannt (`api.anthropic.com` bzw. `…/anthropic` → Claude, sonst Responses) und lässt sich unter „Erweitert“ überschreiben. Der Verbindungstest prüft einen echten Werkzeugaufruf mit Rückgabe und Streaming; Claude-Modelle auf Foundry bieten natives Tool-Calling am Anthropic-Endpunkt derselben Ressource (`https://<resource>.services.ai.azure.com/anthropic`) – der Dialog schlägt ihn vor. Für Claude: Thinking ist immer an und wird nur über `effort` gesteuert (Standard `high`), Werkzeugaufrufe werden nie erzwungen (`tool_choice: auto`), Systemanweisung und Werkzeugliste werden gecacht, Task-Budget (nur Claude API) und Kompaktierung werden genutzt, wo verfügbar, und abgeschaltet, wenn ein Endpunkt sie ablehnt. Der Verlauf wird anbieterneutral gespeichert – ein Wechsel des Anbieters braucht keinen Neustart.
- **Modi**: „Auto“ (Standard) führt Änderungen selbst aus, protokolliert sie und macht sie auf Wunsch rückgängig; „Fragen“ bereitet jede Änderung als Vorschlag vor (eine Karte, ganz oder teilweise bestätigbar). Pro Gespräch umschaltbar, auch per „frag mich diesmal vorher“. Immer nachgefragt wird bei endgültigem Löschen, Änderungen an Originaldateien außerhalb des Archivs, Datenschutz-Einstellungen, neuen Hauptkategorien und Massenaktionen über der Schwelle (Standard: mehr als 100 Einträge in einem Lauf).
- **Agentenläufe**: Jeder Lauf hat eine Lauf-ID mit Auslöser, Anbieter und Modell, Werkzeugaufrufen (gekürzte Ergebnisse), Tokens und geschätzten Kosten, Dauer und Ergebnis. Jede Änderung trägt die Lauf-ID (Änderungsprotokoll, Beziehungen mit Herkunft `agent`); „Lauf rückgängig“ setzt alle Änderungen in umgekehrter Reihenfolge mit Konfliktprüfung zurück, einzelne Schritte ebenso. Ansicht unter Einstellungen → Agent.
- **Sicherheit**: Dokumentinhalte gehen nur als markierte Daten an das Modell, nie als Anweisungen; enthält ein Dokument eine Aufforderung an den Agenten, ändert der Lauf nichts ohne eigene Bitte des Benutzers (im Hintergrund nur als Vorschlag). Jedes Werkzeugergebnis läuft durch den Datenschutzfilter (nicht freigegebene Dokumente nur mit Endung, Ordner und Status), Geheimnisse werden vor jeder Übertragung maskiert, und welche Dokumente an das LLM gingen, steht im Übertragungsprotokoll.
- **Verbrauch**: Tokens (Eingabe, Ausgabe, Cache) pro Anfrage und Lauf, Kosten aus einer pflegbaren Preistabelle – nur zur Information, es gibt keine Kostenobergrenze. Übersicht pro Tag und Monat, nach Chat und Hintergrund.
- **Hintergrund**: neue Dateien nach Scan bzw. Analyse einsortieren, agentische Archivprüfung, Verknüpfungsvorschläge (bleiben Vorschläge), geplante eigene Abläufe – als Jobs mit eigenem Budget, abbrechbar, je Lauf eine gebündelte Benachrichtigung. Dazu Fristen-Wächter und Wochenrückblick (ohne LLM).
- **Lernen heißt Speichern, nicht Trainieren**: Regeln, eigene Abläufe, Korrekturen, Vorlieben und Wissen über den Benutzer werden gespeichert und jedem Lauf mitgegeben – nur auf ausdrücklichen Wunsch oder nach Rückfrage, nie aus Dokumenten. Nach mehreren gleichartigen Korrekturen schlägt Archivist eine Regel vor. Alles ist unter Einstellungen → Agent einsehbar, abschaltbar und löschbar; Gelerntes hebt nie Modus, Ausnahmen, Datenschutz oder Grenzen auf.

## Entwicklung, Tests, Build

```bash
npm run build                       # Renderer (next build → out/) + Main/Preload/Worker/Lese-Worker (esbuild → apps/desktop/dist)
npm run dist                        # Windows: NSIS-Installer + portable EXE (apps/desktop/release/)
npm run dist:win                    # dasselbe (Alias)
npm run db:generate                 # Drizzle-Migration aus Schemaänderungen erzeugen
```

Testabdeckung (Vitest, `npm test`): Decision-Rückfragen, Zod-Validierung von LLM-Ausgaben, IPC-Eingabevalidierung, Pfadnormalisierung, Path-Traversal, Symlink-Ausbruch, Scan-Bereichsgrenzen, Datei-Ausschlüsse, Duplikaterkennung, Bestätigungsworkflows, Archivieren durch Kopieren/Verschieben, Undo (inkl. Konflikte), Datenbankmigrationen, Job-Queue nach Neustart, Widerspruchserkennung mit kontrollierten Beispielen, Maskierung von Schlüsseln in Logs, Verhalten bei nicht erreichbarem LLM, Worker-Threads, Backups, Renderer-Auslieferung/CSP. Die Playwright-E2E-Tests (`tests/e2e`) starten pro Test die echte Electron-App mit frischem Datenordner und einem lokalen Fake-LLM-HTTP-Server. Sie sind nach Funktionen aufgeteilt (Einrichtung, Import/Archivierung, OCR, Chat-Entscheidungen, Chat-Eingabe, Timeline, Scan) und nutzen Page Objects (`tests/e2e/pages`) mit `locators` und `do`, sodass die Specs wie eine Beschreibung des Verhaltens lesen. Dazu prüft `accessibility.spec.ts` jeden Bereich der Navigation mit axe-core (WCAG 2.2 AA); schwere und kritische Verstöße lassen den Test fehlschlagen. Lokal: `npm run build && xvfb-run -a npx playwright test` (unter Windows ohne `xvfb-run`).

### Qualitätssicherung (CI)

| Prüfung | Wo |
|---|---|
| Secret-Scan über die gesamte Historie (gitleaks, Konfiguration `.gitleaks.toml`) | `hygiene`-Job; lokal als pre-commit-Hook |
| Hygiene-Hooks (YAML/JSON, Merge-Konflikte, private Schlüssel, große Dateien) und Workflow-Linter zizmor | `.pre-commit-config.yaml`; lokal mit `pip install pre-commit && pre-commit install` (oder `prek install`) |
| Typecheck, ESLint (type-aware, `jsx-a11y`, `sonarjs`, `--max-warnings 0`), Vitest mit Coverage-Schwellen (`vitest.config.mts`), Build, Electron-E2E, Windows-Installer | `test`- bzw. `windows-installer`-Job |
| Formatierung (Prettier), Architekturgrenzen (dependency-cruiser: Renderer kennt nur `shared`, Core ohne Electron/UI, keine Laufzeit-Zyklen), toter Code (Knip) | `test`-Job; lokal `npm run format`, `npm run depcruise`, `npm run knip` |
| Statische Sicherheitsanalyse (CodeQL, `security-extended`; Ergebnisse unter Security → Code scanning) | `codeql.yml`, bei PR, Push auf `main` und wöchentlich |
| Aktualisierung von Actions, Hook-Revisionen und npm-Abhängigkeiten | Dependabot (`.github/dependabot.yml`); Electron und native Module werden nie automatisch gemergt |

- Coverage lokal: `npm run test:coverage` (Bericht in `coverage/`). Die Schwellen in `vitest.config.mts` liegen knapp unter dem Ist-Wert und werden nur angehoben, nie gesenkt.

Alle Actions sind auf Commit-SHAs gepinnt (Kommentar nennt den Tag), Workflows laufen standardmäßig ohne Token-Rechte (`permissions: {}`) und mit `persist-credentials: false`.

### Texte und Ansprache

**Ansprache**: Wir duzen – in der Oberfläche, im Chat, in Benachrichtigungen, Fehlermeldungen und der Dokumentation. Die LLM-Prompts weisen das Modell entsprechend an, den Benutzer mit „du“ anzusprechen.

**Sprache**: Alles, was programmiert ist, ist Englisch – Bezeichner, Code-Kommentare, Testnamen, Log-Meldungen, Build- und CI-Ausgaben. Alles, was Benutzer sehen, ist Deutsch – Oberfläche, Fehlermeldungen, Benachrichtigungen, Hinweise, Chat-Antworten. Deutsch bleiben auch die LLM-Prompts (sie erzeugen deutsche Antworten), Muster für deutsche Eingaben und Testdaten.

## Evaluation des Agenten

`npm run eval:agent` prüft den Agentenmodus mit **echten Modellen** (Claude und ChatGPT) an knapp 60 realistischen Aufgaben aus allen Stories des Epics #294 (`tests/eval/tasks.ts`): „Verschiebe alle Folien nach presentations“, „Wie viel habe ich 2025 für Handwerker ausgegeben?“, „Wann muss ich den Mietvertrag spätestens kündigen?“, „Fehlt ein Kontoauszug?“, „Merk dir: Rechnungen der Stadtwerke immer nach finanzen/energie“, „Leg zu allen Kündigungsfristen Erinnerungen an“, unklare Anliegen, ein Dokument mit eingeschleuster Anweisung, Modus „Fragen“, Massenaktionen über der Schwelle, Hintergrund-Läufe u. v. m.

- Jede Aufgabe läuft in einer frischen App mit einem Test-Archiv aus ~40 kleinen Dokumenten (Folien, Handwerkerrechnungen, Kontoauszüge mit Lücke, Mietvertrag in zwei Fassungen, Garantie, Versicherung, E-Mails, Duplikate, ein gesperrtes Dokument). Das Archiv wird **ohne LLM** aufgebaut (Import nur lokal, Ordner, Typ und Datum explizit); Fristen liegen relativ zu heute.
- Bewertet wird das **Ergebnis im Archiv**, nicht der Weg: Dateien im richtigen Ordner und sonst nichts verändert (Vorher/Nachher-Abgleich aller Pfade und Metadaten), Erinnerungen mit dem richtigen Datum, eine Rückfrage bei unklarem Anliegen (Laufstatus `ask_user`), ignorierte Anweisungen aus Dokumenten, die deterministische Summe in der Antwort usw.
- **Kostet Geld** und ist deshalb **nicht Teil von `npm test` und der CI** (eigene Konfiguration `vitest.eval.config.mts`, nur `tests/eval/**/*.eval.ts`, Aufgaben nacheinander). Ohne konfigurierte Anbieter wird sie sauber übersprungen. Damit der Code nicht veraltet, prüft `tests/unit/agent-eval-tasks.test.ts` im normalen Testlauf Aufgabenliste und Archivaufbau mit dem Fake-LLM.

Konfiguration über Umgebungsvariablen:

| Variable | Bedeutung |
|---|---|
| `ARCHIVIST_EVAL_PROVIDERS` | Kommaliste von Namen, z. B. `claude,gpt` |
| `ARCHIVIST_EVAL_<NAME>_BASE_URL` | Base URL wie im Einrichtungsassistenten (bestimmt den Adapter) |
| `ARCHIVIST_EVAL_<NAME>_MODEL` | Modell- bzw. Deployment-Name |
| `ARCHIVIST_EVAL_<NAME>_API_KEY` | API-Key |
| `ARCHIVIST_EVAL_<NAME>_EFFORT` | optional: `low`, `medium`, `high` (Standard), `xhigh`, `max` |
| `ARCHIVIST_EVAL_<NAME>_ADAPTER` | optional: `auto` (Standard), `anthropic`, `openai` |
| `ARCHIVIST_EVAL_TASKS` | optional: nur diese Aufgaben-IDs oder Stories, z. B. `move-slides,#309` |

`<NAME>` ist der Name in Großbuchstaben (Sonderzeichen werden zu `_`).

```bash
# Claude auf Microsoft Foundry (Anthropic-Endpunkt) und GPT auf Azure OpenAI
export ARCHIVIST_EVAL_PROVIDERS=claude,gpt
export ARCHIVIST_EVAL_CLAUDE_BASE_URL=https://<resource>.services.ai.azure.com/anthropic
export ARCHIVIST_EVAL_CLAUDE_MODEL=claude-opus-5-5
export ARCHIVIST_EVAL_CLAUDE_API_KEY=...
export ARCHIVIST_EVAL_CLAUDE_EFFORT=high
export ARCHIVIST_EVAL_GPT_BASE_URL=https://<resource>.openai.azure.com/openai/v1
export ARCHIVIST_EVAL_GPT_MODEL=<deployment>
export ARCHIVIST_EVAL_GPT_API_KEY=...
npm run eval:agent
```

Ergebnis: `eval-results/agent-<Zeitstempel>.json` und `.md` (nicht im Repository) – je Anbieter Quote, Kosten, Tokens, Ø Runden und Ø Dauer, je Aufgabe bestanden/fehlgeschlagen mit Grund, dazu der Vergleich mit dem vorigen Ergebnis (neue Fehlschläge und Behobenes hervorgehoben). Am Ende werden die Kosten des Laufs ausgegeben (Schätzung aus der Preistabelle; ein Modell ohne Eintrag zählt mit 0).

**Effort und Budgets abstimmen**: Denselben Anbieter mehrfach mit unterschiedlichem Effort eintragen (z. B. `claude-high` und `claude-medium` mit gleicher URL) und Quote gegen Kosten und Dauer abwägen; nach Änderungen an Prompt, Werkzeugen oder Grenzen zeigt der Vergleich mit dem vorigen Lauf, welche Aufgaben neu scheitern. Läufe, die an `limit` scheitern oder sehr viele Runden brauchen, sprechen für höhere `chatLimits`/`backgroundLimits` – oder für ein Werkzeug, das die Arbeit deterministisch erledigt. Für schnelle Iterationen mit `ARCHIVIST_EVAL_TASKS` nur die betroffenen Aufgaben laufen lassen.

## Packaging

- **Native Module**: `better-sqlite3` (≥ 13) und `sharp` liefern **N-API-Prebuilds** für Windows; dieselbe Binärdatei läuft in Node und Electron. Ein `electron-rebuild` ist deshalb nicht nötig (`npmRebuild: false`), das Cross-Packaging ist reproduzierbar. `npm run native:check` beweist das für Node *und* die Electron-Laufzeit. In der Anwendung liegen die Module per `asarUnpack` außerhalb des ASAR-Archivs.
- **Gebündelt** (esbuild): Main, Preload, Worker, alle reinen JS-Abhängigkeiten. **Extern** (werden mitgeliefert): `better-sqlite3`, `sharp`, `pdfjs-dist`.
- **Windows**: `npm run dist:win` (NSIS-Installer mit Installationsverzeichnis-Auswahl + portable EXE). Der letzte Schritt (Ressourcen-Bearbeitung/Signierung der `.exe`) benötigt **Windows oder Wine** – auf einem Linux-Host ohne Wine bricht electron-builder dort ab (verifiziert: Download, ASAR-Paketierung und NSIS-Toolchain laufen bis dahin). Die CI-Konfiguration (`.github/workflows/ci.yml`) baut den Installer daher auf `windows-latest`. **Signierung**: Installer *und* portable EXE werden per Authenticode (SHA-256, RFC-3161-Zeitstempel) signiert, sobald ein Zertifikat vorliegt – lokal über die Umgebungsvariablen `CSC_LINK` (Pfad oder Base64 der `.pfx`) und `CSC_KEY_PASSWORD`. In der CI genügen die Repository-Secrets `WIN_CSC_LINK` (Base64-kodierte `.pfx`, z. B. `base64 -w0 zertifikat.pfx`) und `WIN_CSC_KEY_PASSWORD`; der Job prüft danach mit `Get-AuthenticodeSignature`, dass alle `.exe`-Dateien gültig signiert sind. Ohne Zertifikat bleiben die Pakete unsigniert (SmartScreen zeigt dann eine Warnung); das ist der Normalfall für Pull Requests aus Forks. Hinweis: Ein selbstsigniertes Zertifikat ist nur auf Rechnern vertrauenswürdig, in deren Zertifikatsspeicher es importiert wurde – gegen die SmartScreen-Warnung helfen nur ein Zertifikat einer öffentlichen CA bzw. Azure Trusted Signing.
- **App-ID** `io.github.besessener.archivist` (Reverse-DNS von `besessener.github.io`, die Domain gehört uns über GitHub). Der NSIS-Installer setzt sie als AppUserModelID der Verknüpfungen, und die App setzt beim Start dieselbe ID – nur dann zeigt Windows Desktop-Benachrichtigungen. In der Entwicklung (`npm run dev`) gilt `electron.exe` als App: Für Benachrichtigungen dort `node_modules\electron\dist\electron.exe` an „Start“ anheften. Die ID darf nach der ersten Verteilung nicht mehr geändert werden, sonst funktionieren stille Updates bestehender Installationen nicht mehr.
- **Releases** (`.github/workflows/release.yml`): Ein gepushter Versions-Tag `v1.2.3` veröffentlicht Installer und portable EXE als **GitHub Release**; Merges auf `main` und Pull Requests bauen die Pakete nur. Ablauf: Version in `package.json` und `apps/desktop/package.json` erhöhen, mergen, dann `git tag v1.2.3 && git push origin v1.2.3`. Der Workflow prüft zuerst, dass Tag und Versionen übereinstimmen (`scripts/check-release-version.mjs`), führt Typecheck, Lint und Tests aus und ruft dann auf `windows-latest` `npm run release:win` auf (electron-builder `--publish always`, Provider `github`, `GITHUB_TOKEN` mit `contents: write`). Tags mit Zusatz (`v1.2.3-beta.1`) erscheinen als Vorabversion. Signiert wird wie im CI-Build über die Secrets `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`; ohne Zertifikat ist das Release unsigniert (SmartScreen-Warnung). Auto-Update (`electron-updater`) ist nicht eingerichtet, deshalb werden keine Update-Metadaten hochgeladen.
- **Nur Windows**: Linux- und macOS-Pakete werden nicht mehr gebaut. Unit-, Integrations- und E2E-Tests laufen in der CI weiterhin auf Ubuntu (schnell und günstig); gepackt wird ausschließlich auf `windows-latest`.

## Bewusste Abweichungen und ehrliche Grenzen

- **LLM-Client**: ein typisierter Fetch-Client statt des offiziellen OpenAI-SDKs – volle Kontrolle über Timeouts, Fallbacks für Azure-/kompatible Endpunkte und keine zusätzliche Abhängigkeit. Das Responses-API-Format ist identisch.
- **Vektorsuche**: `sqlite-vec` wird **nicht** verwendet (Packaging-Risiko über Plattformen hinweg). Stattdessen: Embeddings als BLOB in SQLite; beim ersten Suchen pro Modell einmal (ohne Texte) in einen Vektorindex im Speicher geladen, der beim Indexieren/Entfernen mitgeführt wird. Die Vektoren liegen in `SharedArrayBuffer`-Segmenten, die Worker-Threads lesen sie ohne Kopie; pro Suchanfrage wird nur der Anfragevektor übergeben, die Cosine-Ähnlichkeit läuft segmentweise parallel im Worker-Pool. Ohne konfiguriertes Embedding-Modell nutzt Archivist **lokale Feature-Hashing-Vektoren** (Wörter + Zeichen-Trigramme): offline, deterministisch und für vertrauliche Dokumente geeignet, aber lexikalisch-morphologisch und kein echtes semantisches Modell. Mit konfiguriertem Embedding-Modell (`/embeddings`) werden zusätzlich echte Embeddings verwendet (sofern der Datenschutzmodus es erlaubt).
- **XLSX**: Ein eigener, kleiner ZIP/XML-Leser statt SheetJS (die auf npm verfügbare Version hat bekannte, ungepatchte Schwachstellen). Er liest Tabellenblätter als Text; Datumszellen erscheinen als Excel-Seriennummer, Formeln nur mit ihrem zuletzt gespeicherten Wert.
- **OCR**: eingebaut und standardmäßig aktiv (Einstellungen → Archiv). Bilder (PNG/JPG) und PDFs ohne Textebene (Scans) werden lokal mit `tesseract.js` erkannt – Worker, WASM-Kern und Sprachdaten (Deutsch + Englisch, Pakete `@tesseract.js-data/*`) liegen im Installationspaket, es wird **nichts aus dem Netz geladen**. Die Sprachdaten werden beim ersten Einsatz nach `index/tessdata/` kopiert; weitere Sprachen: `ocr.languages` (z. B. `deu+eng` oder `deu+chi_sim`, Paket `@tesseract.js-data/<code>` muss installiert sein). Bilder werden vor der Erkennung gedreht, kontrastiert und ggf. vergrößert; PDFs werden seitenweise gerendert (max. 40 Seiten). Bei Fehlern wird der Grund sichtbar gemeldet und die Datei trotzdem archivierbar gehalten.
- **Hintergrundbetrieb**: Scans, Erinnerungen und Archivprüfungen laufen nur, **solange Archivist geöffnet ist**. Es gibt keinen Tray-Prozess, Autostart oder Betriebssystemdienst; die Anwendung behauptet nichts anderes. Änderungen an Zeitplänen (Scan-Einstellungen, freigegebene Ordner, Intervall der Archivprüfung, auch 0 = aus) wirken sofort, ohne Neustart. Der Zeitpunkt der letzten Archivprüfung wird gespeichert (Tabelle `app_state`), das Intervall gilt deshalb über Neustarts hinweg: Nach dem Start wird nur geprüft, wenn das Intervall seit dem letzten Lauf abgelaufen ist (bzw. wenn „beim Start prüfen“ eingeschaltet ist – dann genau einmal).
- **Archivpfad ändern** (Einstellungen → Archiv): Archivierte Dokumente verweisen auf ihren Platz *innerhalb* des Archivordners. Beim Ändern stehen deshalb zwei Wege zur Wahl (oder Abbrechen): **„Archiv umziehen“** kopiert den gesamten Archivordner als Hintergrundaufgabe mit Fortschrittsanzeige in den neuen Ordner (nichts wird überschrieben, jede Kopie per Prüfsumme geprüft) und stellt erst danach um; der bisherige Ordner bleibt unverändert erhalten, und der Umzug lässt sich rückgängig machen (die unveränderten Kopien werden dabei wieder entfernt). **„Nur Pfad ändern“** ist für Dateien gedacht, die schon dort liegen: Archivist prüft vorher, ob alle archivierten Dokumente im neuen Ordner vorhanden sind, und stellt bei fehlenden Dateien nur nach ausdrücklicher Bestätigung um – die Oberfläche nennt dabei die Anzahl betroffener Dokumente und warnt danach weiterhin, solange sie nicht erreichbar sind. Während eines Umzugs sind Archivieren und Umlagern gesperrt.
- **Löschen** (Stufe 3) ist bewusst nicht implementiert. Ausnahme: Ereignisse lassen sich nach Bestätigung löschen; das Löschen ist über das Änderungsprotokoll rückgängig machbar.
- Die Widerspruchserkennung ist zurückhaltend: lexikalische Gegensätze (z. B. weiterführen vs. pausieren, unterschiedliche Auswahl „für X/Y“) plus optionale LLM-Bestätigung – es sind **Hinweise**, keine festgestellten Wahrheiten.
- Die Oberfläche ist ausschließlich Deutsch.

## Fehlerbehebung

| Symptom | Ursache / Lösung |
| --- | --- |
| „Ein natives Modul passt nicht zur Laufzeitumgebung“ | `npm install` erneut ausführen und `npm run native:check` prüfen. |
| LLM-Test: „nicht erreichbar“ | Base URL/Proxy/Firewall prüfen; Logs unter `…/Archivist/logs/`. |
| LLM-Test: „Endpunkt oder Modell nicht gefunden“ | Base URL muss auf die API-Wurzel (z. B. `…/openai/v1`) zeigen, Modellname exakt wie im Deployment. |

Lizenz: MIT (siehe `LICENSE`).
