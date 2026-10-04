# Projektstruktur und Services

## Verzeichnisse

```
archivist/
├── apps/
│   ├── desktop/            Electron: main.ts, preload.ts, renderer-server.ts (app://-Protokoll + CSP),
│   │                       scripts/ (esbuild-Build, Dev), electron-builder.yml, build/ (Icon)
│   └── renderer/           Next.js (statischer Export): app/, components/, lib/
├── packages/
│   ├── shared/             Zod-Schemas (Domäne, Einstellungen, LLM-Ausgaben) + IPC-Vertrag
│   └── core/               Service-Layer, Drizzle-Schema + Migrationen (migrations/), Parser, Worker,
│                           LLM-Client, Agent (src/agent/)
├── tests/
│   ├── unit/               Pfade, Datum, Maskierung, Schemas, Parser, Renderer-Auslieferung …
│   ├── integration/        Vertikaler Slice, Chat/Decisions, Scanner, Archivsicherheit, Plattform
│   ├── e2e/                Playwright gegen die echte Electron-App (+ Fake-LLM-HTTP-Server)
│   └── eval/               Agent-Evaluation mit echten Modellen (nicht Teil von npm test)
├── scripts/                check-native.mjs, check-release-version.mjs, mutation-summary.mjs
├── docs/                   diese Dokumentation
├── config.example.json     Beispielkonfiguration (ohne Zugangsdaten)
└── .env.example            dokumentierte Umgebungsvariablen (werden nicht automatisch geladen)
```

## Wichtige Dateien

| Datei | Inhalt |
| --- | --- |
| `packages/shared/src/ipc.ts` | IPC-Vertrag: Input- und Output-Schema je Kanal |
| `packages/core/src/db/schema.ts` | Drizzle-Schema der Datenbank; die Tabellen liegen nach Bereich in `db/tables/` (Wissen, Dokumente, Einträge, Hinweise, Agent, System) |
| `packages/core/src/agent/runner.ts` | Agentenschleife |
| `packages/core/src/agent/gate.ts` | Entscheidung je Werkzeugaufruf: ausführen, vorschlagen oder blockieren |
| `apps/desktop/src/main.ts` | Electron-Main-Prozess |
| `apps/desktop/electron-builder.yml` | Packaging-Konfiguration |
| `.dependency-cruiser.cjs` | Architekturgrenzen |

## Services (`@archivist/core`)

Erzeugt und verdrahtet in `packages/core/src/create-services.ts`; die Schritte liegen in `composition/` (Basisdienste, Fachdienste, Agent, Verdrahtung, Verknüpfungsautomatik, Job-Handler, Start und Beenden). Die IPC-Handler liegen nach Bereich in `handlers/` (App, Agent, Einträge, Dokumente, Wissen); `handlers.ts` setzt sie zusammen und validiert Ein- und Ausgabe.

| Service | Datei | Aufgabe |
| --- | --- | --- |
| `DatabaseService` | `db/database.ts` | Verbindung und Migrationen |
| `SettingsService` | `services/settings.ts` | Einstellungen lesen, validieren, speichern |
| `migrateLegacyLayout` | `services/data-layout-migration.ts` | zieht die Anwendungsdaten der alten Ablage beim Start in den Datenordner um (kopieren, prüfen, umschalten) |
| `SecretService` | `services/secret.ts` | API-Key über `SecretCipher` (safeStorage) |
| `AppStateService` | `services/app-state.ts` | kleiner Schlüssel-Wert-Speicher, der Neustarts überlebt (`app_state`) |
| `PrivacyService` | `services/privacy.ts` | Datenschutzmodus, Ausschlüsse, Maskierung |
| `LlmService` | `services/llm.ts` | LLM-Client (Responses API) |
| `EmbeddingService` | `services/embedding.ts` | Embeddings und lokale Hash-Vektoren |
| `SearchService` | `services/search.ts` | hybride Suche (FTS5 + Vektoren) |
| `KnowledgeGraphService` | `services/knowledge-graph.ts` | Entitäten und Beziehungen |
| `PersonService` | `services/persons.ts` | zentrale Auflösung von Personen-Erwähnungen |
| `SelfService` | `services/self.ts` | die eigene Person („Du“) |
| `CategoryService` | `services/categories.ts` | Kategorien und Hauptkategorien |
| `CategoryMigrationService` | `services/category-migration.ts` | Einmaliges Umbenennen von `work`/`private` in `Arbeit`/`Privat` (Vorschau, Bestätigung, Umlagern) |
| `DocumentService` | `services/documents.ts` | Import, Parser, Klassifikator |
| `ArchiveService` | `services/archive.ts` | Archivieren und Umlagern |
| `ArchiveRootService` | `services/archive-root.ts` | Archivpfad ändern bzw. Archiv umziehen |
| `ScannerService` | `services/scanner.ts` | Verzeichnisscan |
| `DecisionService` | `services/decisions.ts` | Entscheidungen |
| `OpenItemService` | `services/open-items.ts` | offene Punkte |
| `NoteService` | `services/notes.ts` | Notizen (anlegen, bearbeiten mit Undo) |
| `NoteAnalysisService` | `services/note-analysis.ts` | Analyse von Notizen: Thema, Projekt, Personen, Tags als Vorschläge |
| `EventService` | `services/events.ts` | Ereignisse |
| `ReminderService` | `services/reminders.ts` | Erinnerungen |
| `NotificationService` | `services/notifications.ts` | Notification Bell und Desktop-Benachrichtigungen |
| `TimelineService` | `services/timeline.ts` | Timeline |
| `SolutionService` | `services/solutions.ts` | Lösungsvorschläge für offene Punkte |
| `ConsistencyService` | `services/consistency.ts` | Archivprüfung |
| `InsightService` | `services/insights.ts` | Hinweise der Archivprüfung |
| `ContradictionService` | `services/contradictions.ts`, `contradiction-review.ts`, `contradiction-notices.ts`, `document-contradictions.ts`, `document-contradiction-rules.ts` | Widerspruchserkennung zwischen Entscheidungen und zwischen Dokumenten; das LLM-Urteil je Textpaar speichert `contradiction_reviews` |
| `OpenItemDuplicateService`, `NoteEventDuplicateService`, `PersonDuplicateService`, `PersonQuestionService`, `EntityDuplicateCheck` | `services/cleanup/` | Dublettenprüfungen der Archivprüfung |
| `ActionService` | `services/actions.ts` | Vorschläge (`agent_actions`) und ihre Bestätigung |
| `ChatService` | `services/chat.ts` | Gesprächsablauf; Intent-Erkennung und `dispatch()` als regelbasierter Rückfall |
| `CaptureService` | `services/capture.ts` | Wissen erfassen (Entscheidungen, Notizen, offene Punkte, Erinnerungen, Ereignisse) – für Agentenwerkzeuge und Rückfall |
| `KnowledgeAnswerService` | `services/knowledge-answers.ts` | geprüfte Wissensantworten mit Quellen |
| `LinkMethodsService` | `services/link-methods.ts` | Verknüpfungsmethoden (ähnliche Einträge, gleicher Tag + Person, gemeinsam entstanden, verwaiste Einträge, Themen aus Gruppen), Vorschlagsliste, verwandte Einträge, rückwirkender Lauf |
| `AgentService` | `agent/service.ts` | Agentenmodus in Chat und Hintergrund |
| `AgentRunService` | `agent/runs.ts` | Agentenläufe und „Lauf rückgängig“ |
| `AgentFileJobs` | `agent/file-jobs.ts` | große Dateiaktionen des Agenten als eigener Auftrag |
| `MemoryService` | `agent/memory.ts` | Gedächtnis des Agenten (Regeln, Abläufe, Vorlieben) |
| `JobQueueService` | `services/jobs.ts` | persistente Job-Queue |
| `AuditService` | `services/audit.ts` | Änderungsprotokoll |
| `UndoService` | `services/undo.ts` | Rückgängig machen |
| `BackupService` | `services/backup.ts` | Backups |

### Aufteilung der großen Services

Jede Service-Klasse bleibt unter dem Pfad aus der Tabelle; ihre Teile liegen daneben:

| Service | Teile | Inhalt |
| --- | --- | --- |
| `ChatService` | `services/chat/` | Gesprächsspeicher, Intent-Erkennung (LLM und regelbasiert), Ablauf einer Nachricht, Rückfragen, Antworten zu Suche, Archiv und Vorschlägen |
| `CaptureService` | `services/capture/` | Erfassen von Entscheidungen (inkl. Ersetzen), offenen Punkten, Erinnerungen, Notizen und Ereignissen |
| `KnowledgeGraphService` | `services/graph/` | Entitäten, Beziehungen, Ansichten, Nachbarschaftsgraph, Verknüpfungen des Benutzers, Zusammenführen und Umbenennen mit Undo |
| `LinkMethodsService` | `services/links/` | Kandidaten, Vorschlagsliste, verwandte und verwaiste Einträge, Kennzahlen, Themen aus Gruppen, gemeinsamer Ursprung, rückwirkender Lauf |
| `ConsistencyService` | `services/archive-check/` | die einzelnen Prüfschritte der Archivprüfung und ihre Zusammenfassung |
| `ArchiveService` | `services/archive-*.ts` | Plan, Ausführung, Dateioperationen ohne Überschreiben, Sperren, Umlagern, Umbenennen, Undo, Wartung |
| `ArchiveRootService` | `services/archive-root-*.ts` | Prüfung und Plan des Umzugs, Kopieren mit Prüfsumme |
| `DocumentService` | `services/document-*.ts` | Import und Quarantäne, Ordnerimport (`document-import-folder.ts`), gebündelte Analyse mehrerer Dokumente (`document-batch.ts`), Analyse und Klassifikation (Neueinreihung bei LLM-Limit: `analysis-retry.ts`), erneutes Lesen, Neuanalyse-Vorschläge (`document-reanalysis.ts`) und „Neu verarbeiten“ (`document-reprocess.ts`), Suchindex ergänzen (`document-index.ts`), Metadaten mit Undo, Massenänderung; Ähnlichkeit über MinHash (`near-duplicates.ts`, rein: `util/minhash.ts`) |
| `ActionService` | `services/action-*.ts` | Ausführung je Aktionstyp, erneute Prüfung vor der Ausführung |
| `DecisionService`, `OpenItemService`, `SolutionService` | `services/decision-*.ts`, `open-item-*.ts`, `previous-values.ts`, `solution-content.ts` | reine Feldlogik, Erkennung, Undo-Handler, Lösungs-Prompt |
| `SubjectService` | `services/subject-*.ts` | Plan einer Massenzuordnung und ihr Undo |
| `InsightService`, `SearchService`, `ContradictionService`, `KnowledgeAnswerService` | `services/insight-*.ts`, `search-*.ts`, `contradiction-rules.ts`, `knowledge-*.ts` | Vorschläge und Antworten zu Hinweisen, Stichwortsuche und Rangfusion, lexikalische Widerspruchsprüfung, Quellen und Antworttext |
| `LlmService` | `services/llm/` | HTTP, optionale Parameter, Responses API, Eingabe und JSON, Endpunktzustand, Übertragungsprotokoll |
| `JobQueueService` | `services/jobs/` | Fehlertypen, Zeilen, Kontext eines Versuchs, Ergebnis eines Versuchs, Wartezeiten |
| `ScannerService` | `services/scanner/` | Dateizeilen, Scanlauf, Inhaltsanalyse, „Alle neuen Dateien analysieren“ (`bulk-analysis.ts`), Zuordnungsvorschläge |
| Dubletten der Archivprüfung | `services/cleanup/` | Namensvergleich, Bewertung, Hinweistexte, Zusammenführen von Notizen und Ereignissen, Verknüpfungen zusammengeführter Einträge |
| Parser | `parsers/` | Ergebnis- und Texttypen, PDF, DOCX/PPTX, XLSX |
| `AgentService` | `agent/*.ts` | Gate (ausführen, vorschlagen, blockieren), Ausführung der Werkzeugaufrufe, Verlauf, Fähigkeitstest, Laufausführung, Hintergrundaufgaben, Korrekturen |
| Agentenwerkzeuge | `agent/tools/` mit `research/`, `exports/` | Werkzeugdefinitionen; Rechercheberichte (Beträge, Fristen, Lücken, Zahlungen, Mails), Exporte (ZIP, PDF, CSV, Übersicht) |

`packages/shared/src/` ist nach Bereichen aufgeteilt (`documents.ts`, `archive.ts`, `decisions.ts`, `open-items.ts`, `events.ts`, `notifications.ts`, `knowledge.ts`, `links.ts`, `actions.ts`, `chat.ts`, `jobs.ts`, `bulk.ts`, `audit.ts`, `scan.ts`, `status.ts`) und wird über `index.ts` exportiert. Die Kanäle stehen in `ipc.ts`; die der Massenläufe auf langen Listen (`documents:archiveAll…`, `documents:analyzeImport…`) in `ipc-bulk.ts`, das `ipc.ts` einbindet (gemeinsame Helfer in `ipc-channel.ts`).

Im Renderer liegen die Teile einer Seite unter `components/<bereich>/`, z. B. `knowledge/entity-list.tsx`, `decisions/decision-detail.tsx`, `documents/documents-table.tsx`, `chat/chat-composer.tsx`.

Electron-Spezifisches (safeStorage, Dialoge, `shell`) wird über kleine Schnittstellen (`SecretCipher`, `HostApi`) injiziert, siehe [Architektur](../explanation/architektur.md).

## Fehlerkategorien

Jeder IPC-Aufruf liefert ein `Result`. Fehler tragen eine dieser Kategorien:

`validation_error`, `database_error`, `filesystem_error`, `parser_error`, `llm_error`, `network_error`, `permission_error`, `scan_error`, `archive_conflict`, `native_module_error`.
