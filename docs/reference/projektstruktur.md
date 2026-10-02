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
| `packages/core/src/db/schema.ts` | Drizzle-Schema der Datenbank |
| `packages/core/src/agent/runner.ts` | Agentenschleife |
| `apps/desktop/src/main.ts` | Electron-Main-Prozess |
| `apps/desktop/electron-builder.yml` | Packaging-Konfiguration |
| `.dependency-cruiser.cjs` | Architekturgrenzen |

## Services (`@archivist/core`)

Erzeugt und verdrahtet in `packages/core/src/create-services.ts`.

| Service | Datei | Aufgabe |
| --- | --- | --- |
| `DatabaseService` | `db/database.ts` | Verbindung und Migrationen |
| `SettingsService` | `services/settings.ts` | Einstellungen lesen, validieren, speichern |
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
| `DocumentService` | `services/documents.ts` | Import, Parser, Klassifikator |
| `ArchiveService` | `services/archive.ts` | Archivieren und Umlagern |
| `ArchiveRootService` | `services/archive-root.ts` | Archivpfad ändern bzw. Archiv umziehen |
| `ScannerService` | `services/scanner.ts` | Verzeichnisscan |
| `DecisionService` | `services/decisions.ts` | Entscheidungen |
| `OpenItemService` | `services/open-items.ts` | offene Punkte |
| `NoteService` | `services/notes.ts` | Notizen |
| `EventService` | `services/events.ts` | Ereignisse |
| `ReminderService` | `services/reminders.ts` | Erinnerungen |
| `NotificationService` | `services/notifications.ts` | Notification Bell und Desktop-Benachrichtigungen |
| `TimelineService` | `services/timeline.ts` | Timeline |
| `SolutionService` | `services/solutions.ts` | Lösungsvorschläge für offene Punkte |
| `ConsistencyService` | `services/consistency.ts` | Archivprüfung |
| `InsightService` | `services/insights.ts` | Hinweise der Archivprüfung |
| `ContradictionService` | `services/contradictions.ts` | Widerspruchserkennung |
| `OpenItemDuplicateService`, `NoteEventDuplicateService`, `PersonDuplicateService`, `PersonQuestionService`, `EntityDuplicateCheck` | `services/cleanup/` | Dublettenprüfungen der Archivprüfung |
| `ActionService` | `services/actions.ts` | Vorschläge (`agent_actions`) und ihre Bestätigung |
| `ChatService` | `services/chat.ts` | Gesprächsablauf; Intent-Erkennung und `dispatch()` als regelbasierter Rückfall |
| `CaptureService` | `services/capture.ts` | Wissen erfassen (Entscheidungen, Notizen, offene Punkte, Erinnerungen, Ereignisse) – für Agentenwerkzeuge und Rückfall |
| `KnowledgeAnswerService` | `services/knowledge-answers.ts` | geprüfte Wissensantworten mit Quellen |
| `LinkMethodsService` | `services/link-methods.ts` | Verknüpfungsmethoden (ähnliche Einträge, verwaiste Einträge, Themen aus Gruppen, rückwirkender Lauf) |
| `AgentService` | `agent/service.ts` | Agentenmodus in Chat und Hintergrund |
| `AgentRunService` | `agent/runs.ts` | Agentenläufe und „Lauf rückgängig“ |
| `AgentFileJobs` | `agent/file-jobs.ts` | große Dateiaktionen des Agenten als eigener Auftrag |
| `MemoryService` | `agent/memory.ts` | Gedächtnis des Agenten (Regeln, Abläufe, Vorlieben) |
| `JobQueueService` | `services/jobs.ts` | persistente Job-Queue |
| `AuditService` | `services/audit.ts` | Änderungsprotokoll |
| `UndoService` | `services/undo.ts` | Rückgängig machen |
| `BackupService` | `services/backup.ts` | Backups |

Electron-Spezifisches (safeStorage, Dialoge, `shell`) wird über kleine Schnittstellen (`SecretCipher`, `HostApi`) injiziert, siehe [Architektur](../explanation/architektur.md).

## Fehlerkategorien

Jeder IPC-Aufruf liefert ein `Result`. Fehler tragen eine dieser Kategorien:

`validation_error`, `database_error`, `filesystem_error`, `parser_error`, `llm_error`, `network_error`, `permission_error`, `scan_error`, `archive_conflict`, `native_module_error`.
