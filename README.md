# Archivist

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
- [Entwicklung, Tests, Build](#entwicklung-tests-build)
- [Packaging](#packaging)
- [Bewusste Abweichungen und ehrliche Grenzen](#bewusste-abweichungen-und-ehrliche-grenzen)
- [Fehlerbehebung](#fehlerbehebung)

## Funktionsumfang

| Bereich | Umsetzung |
| --- | --- |
| **Chat** (zentrale Schnittstelle) | LLM-gestützte Intent-Erkennung (strukturiert, Zod-validiert) für Entscheidungen, Notizen, Wissensfragen, Dokumentsuche, Timeline, offene Punkte, Erinnerungen, Archivierung, Scan, Ausschlüsse, Widersprüche; **mehrere Absichten pro Nachricht** (werden nacheinander ausgeführt, Rückfragen stellen die übrigen zurück); das LLM kennt dazu die aktiven offenen Punkte, Entscheidungen, offenen Vorschläge des Gesprächs (nur Titel und Metadaten, mit IDs) und Ihren Namen (Einstellungen → Über Sie); Rückfrage statt Raten bei unklarer Absicht und **bevor eine unsichere „Entscheidung“ gespeichert wird** (Entscheidung / Ereignis / Notiz / nichts speichern); **Ereignisse** („am 01.10.2026 eingereicht“) landen mit Datum in der Timeline; Antworten mit Quellen, getrennten Fakten/Interpretation und sichtbaren Unsicherheiten |
| **Decision Tracking** | Pflichtfelder *Wann, Thema, Beteiligte, Entscheidung*; gezielte Rückfragen; Entwurf, bis alles vollständig ist oder ausdrücklich als „unbekannt“ bestätigt wurde; Ersetzen/Widerrufen nur nach Bestätigung |
| **Dokumente** | Drag-and-Drop/Dateiauswahl, sicherer Eingang (`inbox/`), Prüfsumme, Duplikaterkennung, Parser für PDF, DOCX, PPTX, XLSX, EML, TXT/MD, PNG/JPG, Klassifikation (LLM oder lokal), menschenlesbarer Zielpfad, Archivierung per Kopieren/Verschieben/nur Indexieren/Ignorieren, Undo |
| **Wissensgraph** | Entitäten (Document, Decision, Topic, Project, Person, Event, Question→Task, Note, Category, Tag) und Beziehungen mit Confidence/Status (`proposed/confirmed/rejected/outdated`) in SQLite; ändern sich Thema, Projekt oder Beteiligte, werden die automatisch angelegten Beziehungen zum alten Ziel `outdated` (von Ihnen bestätigte oder abgelehnte bleiben unverändert, Rückgängig stellt sie wieder her) |
| **Suche** | Hybrid: FTS5 (BM25) + Vektorähnlichkeit (Cosine, im Worker-Thread), per Reciprocal Rank Fusion fusioniert |
| **Verzeichnisscan** | Nur ausdrücklich freigegebene Ordner, zweistufig (1. technischer Scan ohne LLM, 2. Analyse nur für neue/geänderte/ausgewählte Dateien), Ausschlüsse, manuell / beim Start / periodisch (nur bei laufender App) |
| **Agentische Konsistenzschleife** | Archivprüfung: fehlende Zuordnungen, Duplikate, **Dokumente zum selben Thema in verschiedenen Verzeichnissen (mit Umlager-Vorschlag)**, Widersprüche, unvollständige/überholte Entscheidungen, überfällige/verwaiste offene Punkte, ähnliche Themen, Ablageort vs. Klassifikation, DB-vs-Dateisystem |
| **Insights, Timeline, Notification Bell, Erinnerungen** | siehe UI; die Timeline zeigt auch **Ereignisse** (per Chat oder „Ereignis hinzufügen“ erfasst, durchsuchbar, im Wissensgraph); Erinnerungen werden beim Start geprüft und zeitgesteuert ausgelöst, **solange die App läuft** |
| **Job-Queue** | Persistent in SQLite, überlebt Neustarts, Fortschritt, Wiederholen, kooperativer Abbruch; schwere Arbeit in Worker-Threads |
| **Audit Log + Undo** | Jede relevante Änderung wird protokolliert; Undo prüft vorher, ob seitdem etwas verändert wurde |
| **Backups** | Konsistenter SQLite-Snapshot (Online-Backup-API) + Einstellungen ohne API-Key; Metadaten- vs. vollständiges Archiv-Backup |

### Bedienung in Kürze

1. Beim ersten Start führt ein Einrichtungsdialog durch LLM-Verbindung (Base URL, API-Key, Modell, Verbindungstest), optionale Scan-Verzeichnisse und den Datenschutzmodus.
2. Datei in das Fenster ziehen → Archivist kopiert sie in den Eingang, extrahiert Text, schlägt Kategorie/Zielordner vor → in der **Inbox** Quell- und Zielpfad prüfen → bestätigen.
3. Im **Chat** Entscheidungen mitteilen („Wir haben entschieden, dass wir mit prod-plat erstmal nicht weitermachen.“); Archivist fragt nach Datum, Beteiligten und Thema und speichert erst dann final.
4. Später fragen: „Wann haben wir prod-plat pausiert?“ – Antwort mit Quellen.
   - **Ablage prüfen:** „Sind meine Dateien konsistent?“, „In welchen Verzeichnissen liegen die Dokumente zu Bildungsurlaub 2026?“ – Archivist zeigt, in welchen Verzeichnissen die Dokumente eines Themas oder Projekts liegen, und weist auf verstreute Ablage hin.
   - **Umlagern:** „Können die nicht alle ins selbe Verzeichnis?“ (optional mit Zielordner) – Archivist schlägt als Ziel den Ordner vor, in dem schon die meisten liegen, und bereitet das Verschieben als Aktionskarte vor. Erst nach „ja“ bzw. Bestätigung wird verschoben: nichts wird überschrieben (bei gleichem Namen `Name (2).ext`), geänderte Dateien bleiben liegen, leere Ordner werden aufgeräumt, und das Protokoll bietet **Rückgängig**.
5. Unter **Scan** ein Verzeichnis freigeben (z. B. `~/Downloads`), „Jetzt suchen“, Dateien auswählen, analysieren, Zuordnungsvorschläge bestätigen.

## Schnellstart

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
npm run test:e2e       # Playwright (Electron) – unter Linux headless: xvfb-run -a npm run test:e2e
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
- **Main-Prozess bleibt frei:** Datenbankzugriffe sind kurz (synchrones better-sqlite3); Hashing, Verzeichnisscans, Textextraktion und Vektorsuche laufen im Worker-Pool; langlaufende Abläufe sind Jobs in der persistenten Queue.
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
└── quarantine/    Dateien, deren Inhalt nicht zur Endung passt
```

- Die Ablage bleibt **auch ohne Archivist verständlich**: keine Hash-/UUID-Ordner, keine reinen Dateityp-Ordner (`pdf/`, `docx/` …). Vorgeschlagene Pfade werden bereinigt; Unterkategorien darf der Agent vorschlagen, **neue Hauptkategorien** (erstes Pfadsegment) nur nach Bestätigung.
- Archivdateien werden relativ zum Archivwurzelpfad referenziert (`archive_rel_path`).
- Das Schema steht in `packages/core/src/db/schema.ts` (Drizzle). Migrationen (`packages/core/migrations/`) erzeugt `npm run db:generate`; die FTS5-Tabelle ist eine benutzerdefinierte Migration. Beim Start werden Migrationen automatisch angewendet.

## Sicherheits- und Datenschutzmodell

**Aktionsstufen**

| Stufe | Beispiele | Verhalten |
| --- | --- | --- |
| 1 – automatisch | Dateien in freigegebenen Ordnern auflisten, Metadaten/Prüfsummen, Textextraktion, Suchindex, Vorschläge, Insights, Benachrichtigungen | läuft ohne Rückfrage |
| 2 – Bestätigung | Kopieren/Verschieben ins Archiv, **bereits archivierte Dokumente in einen anderen Archivordner verschieben**, Umbenennen, neue Hauptkategorie, Entscheidung als überholt markieren, Widerspruch lösen, offenen Punkt schließen, Metadaten überschreiben, Themen zusammenführen | Aktionskarte / Dialog mit Quell- und Zielpfad, Begründung, Confidence; ohne `confirmed: true` abgelehnt |
| 3 – besonders | Löschen, Überschreiben, automatisches Umsortieren des ganzen Archivs | **nicht implementiert** – Archivist löscht und überschreibt nichts (auch Undo löscht nie die einzige Kopie: Als weitere Kopie zählt nur eine Datei mit gleicher Prüfsumme am Quell- bzw. Eingangsort. Fehlt sie, weil das Original seitdem bearbeitet oder entfernt wurde, legt Undo die archivierte Fassung an den Ursprungsort zurück, bei Namenskonflikt als `Name (2).ext`). Umlagern ist nur für ausdrücklich genannte Dokumente möglich und wird immer vorher bestätigt. |

**Dateien**: Originale werden nie ohne ausdrückliche Bestätigung verändert. Standard ist *Kopieren*. Zieldateien werden mit `COPYFILE_EXCL` angelegt (kein Überschreiben, bei Namenskollision `Name (2).ext`), per SHA-256 verifiziert und erst danach werden – nur bei „Verschieben“ und zusätzlicher Bestätigung – Quellen entfernt. Pfade werden gegen Traversal (`..`, absolute Pfade, Nullbytes), Symlink-Ausbruch (realpath-Prüfung) und ungültige Dateinamen (Windows-reservierte Namen, Sonderzeichen) abgesichert; Dateien, die sich seit der Analyse geändert haben, werden nicht archiviert.

**Scans**: Nur ausdrücklich freigegebene Verzeichnisse; Wurzeln, Systemverzeichnisse und Verzeichnisse anderer Benutzer werden abgelehnt; das Archivist-Datenverzeichnis wird nie gescannt; Symlinks werden nur verfolgt, wenn ihr Ziel im freigegebenen Bereich liegt; versteckte Einträge und `node_modules` werden übersprungen. Bekannte, unveränderte Dateien (Größe + Änderungszeit) werden weder neu gehasht noch analysiert. Die lokale Dokumentensuche ist **standardmäßig deaktiviert**.

**LLM-Datenschutz** (`Einstellungen → Datenschutz`):

- `auto` – Inhalte automatisch analysieren · `confirm` (Standard) – vor jeder externen Analyse ausdrücklich bestätigen · `local_only` – nie extern (keine Klassifikation, keine Chat-Auswertung, keine Embeddings per LLM).
- Verzeichnisse, Dateitypen und einzelne Dateien lassen sich dauerhaft von der LLM-Verarbeitung ausschließen. In der UI sind die Zustände sichtbar: *nur lokal gescannt · zur LLM-Analyse vorgesehen · per LLM analysiert · von externer Analyse ausgeschlossen*.
- Vor jeder Übertragung werden Zugangsdaten und Geheimnisse (Passwörter, API-Keys, Tokens, JWTs, private Schlüssel, Verbindungsstrings) **maskiert**; jede Übertragung wird mit Zeitpunkt, Zweck, Modell, Größe, Anzahl maskierter Stellen und gekürzter, maskierter Vorschau protokolliert und ist unter *Datenschutz → Übertragungsprotokoll* einsehbar. Gesendet wird mit `store: false`.

**Electron**: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, kein `eval`, Navigation und `window.open` gesperrt, Berechtigungsanfragen abgelehnt. Das Frontend wird über ein eigenes `app://`-Protokoll ausgeliefert (kein HTTP-Server, kein `file://`) mit strenger CSP (`default-src 'none'`, Skripte nur `self` + SHA-256-Hashes der von Next.js erzeugten Inline-Skripte, `connect-src 'self'`). IPC: explizite Kanal-Allowlist, Absender-Prüfung (Frame-URL + WebContents), Zod-Validierung von Ein- **und** Ausgaben. Der Renderer hat keinen Zugriff auf Node, Dateisystem, Datenbank, Shell oder Credential Store; Dateien öffnet nur der Main-Prozess und nur solche, die Archivist kennt.

**Geheimnisse**: Der API-Key wird ausschließlich über Electron `safeStorage` (Windows DPAPI, macOS Keychain, Linux libsecret/kwallet) verschlüsselt in `config/llm-api-key.enc` abgelegt – nie in `settings.json`, Datenbank, Backups oder Logs (der Logger maskiert bekannte Schlüssel zusätzlich aktiv). Ist kein sicherer Speicher verfügbar (z. B. Linux ohne Schlüsselbund), **verweigert** Archivist das Speichern.

## LLM-Anbindung

- Konfigurierbar: Base URL, API-Key, Modellname (nicht im Code verdrahtet), optional reasoning effort, Timeout, maximale Eingabegröße, optionales Embedding-Modell.
- Verwendet wird die OpenAI-kompatible **Responses API** (`POST {baseUrl}/responses`), z. B. `https://<resource>.openai.azure.com/openai/v1`. Authentifizierung wird als `Authorization: Bearer` und `api-key` gesendet.
- Strukturierte Ausgaben: Das JSON-Schema wird aus dem Zod-Schema erzeugt und im Prompt mitgegeben, `text.format = json_object` angefordert; die Antwort wird mit Zod validiert. Bei ungültiger Ausgabe genau eine Korrekturanfrage, danach Verwerfen + sichtbarer technischer Fehler. **Ungültige Ausgaben lösen nie Datei- oder Datenbankänderungen aus.**
- Nicht erreichbarer Endpunkt: verständliche Fehlermeldung, Retries bei transienten Fehlern (Netzwerk/429/5xx), Status in der Kopfzeile; der Chat fällt auf eine regelbasierte Auswertung bzw. lokale Trefferlisten zurück und kennzeichnet das deutlich.
- Antworten auf Wissensfragen: Fakten müssen auf tatsächlich bereitgestellte Quellen verweisen – Aussagen mit ungültigem Quellenbeleg werden verworfen und als Unsicherheit ausgewiesen.

## Entwicklung, Tests, Build

```bash
npm run build                       # Renderer (next build → out/) + Main/Preload/Worker (esbuild → apps/desktop/dist)
npm run dist                        # Installer für die aktuelle Plattform (apps/desktop/release/)
npm run dist:win                    # Windows: NSIS-Installer + portable EXE
npm run db:generate                 # Drizzle-Migration aus Schemaänderungen erzeugen
```

Testabdeckung (Vitest, `npm test`): Decision-Rückfragen, Zod-Validierung von LLM-Ausgaben, IPC-Eingabevalidierung, Pfadnormalisierung, Path-Traversal, Symlink-Ausbruch, Scan-Bereichsgrenzen, Datei-Ausschlüsse, Duplikaterkennung, Bestätigungsworkflows, Archivieren durch Kopieren/Verschieben, Undo (inkl. Konflikte), Datenbankmigrationen, Job-Queue nach Neustart, Widerspruchserkennung mit kontrollierten Beispielen, Maskierung von Schlüsseln in Logs, Verhalten bei nicht erreichbarem LLM, Worker-Threads, Backups, Renderer-Auslieferung/CSP. Die Playwright-E2E-Tests (`tests/e2e`) starten pro Test die echte Electron-App mit frischem Datenordner und einem lokalen Fake-LLM-HTTP-Server. Sie sind nach Funktionen aufgeteilt (Einrichtung, Import/Archivierung, OCR, Chat-Entscheidungen, Chat-Eingabe, Timeline, Scan) und nutzen Page Objects (`tests/e2e/pages`) mit `locators` und `do`, sodass die Specs wie eine Beschreibung des Verhaltens lesen. Dazu prüft `accessibility.spec.ts` jeden Bereich der Navigation mit axe-core (WCAG 2.2 AA); schwere und kritische Verstöße lassen den Test fehlschlagen. Lokal: `npm run build && xvfb-run -a npx playwright test` (unter Windows/macOS ohne `xvfb-run`).

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

## Packaging

- **Native Module**: `better-sqlite3` (≥ 13) und `sharp` liefern **N-API-Prebuilds** für Windows/macOS/Linux; dieselbe Binärdatei läuft in Node und Electron. Ein `electron-rebuild` ist deshalb nicht nötig (`npmRebuild: false`), das Cross-Packaging ist reproduzierbar. `npm run native:check` beweist das für Node *und* die Electron-Laufzeit. In der Anwendung liegen die Module per `asarUnpack` außerhalb des ASAR-Archivs.
- **Gebündelt** (esbuild): Main, Preload, Worker, alle reinen JS-Abhängigkeiten. **Extern** (werden mitgeliefert): `better-sqlite3`, `sharp`, `pdfjs-dist`.
- **Windows**: `npm run dist:win` (NSIS-Installer mit Installationsverzeichnis-Auswahl + portable EXE). Der letzte Schritt (Ressourcen-Bearbeitung/Signierung der `.exe`) benötigt **Windows oder Wine** – auf einem Linux-Host ohne Wine bricht electron-builder dort ab (verifiziert: Download, ASAR-Paketierung und NSIS-Toolchain laufen bis dahin). Die CI-Konfiguration (`.github/workflows/ci.yml`) baut den Installer daher auf `windows-latest`. **Signierung**: Installer *und* portable EXE werden per Authenticode (SHA-256, RFC-3161-Zeitstempel) signiert, sobald ein Zertifikat vorliegt – lokal über die Umgebungsvariablen `CSC_LINK` (Pfad oder Base64 der `.pfx`) und `CSC_KEY_PASSWORD`. In der CI genügen die Repository-Secrets `WIN_CSC_LINK` (Base64-kodierte `.pfx`, z. B. `base64 -w0 zertifikat.pfx`) und `WIN_CSC_KEY_PASSWORD`; der Job prüft danach mit `Get-AuthenticodeSignature`, dass alle `.exe`-Dateien gültig signiert sind. Ohne Zertifikat bleiben die Pakete unsigniert (SmartScreen zeigt dann eine Warnung); das ist der Normalfall für Pull Requests aus Forks. Hinweis: Ein selbstsigniertes Zertifikat ist nur auf Rechnern vertrauenswürdig, in deren Zertifikatsspeicher es importiert wurde – gegen die SmartScreen-Warnung helfen nur ein Zertifikat einer öffentlichen CA bzw. Azure Trusted Signing.
- **Linux** (`apps/desktop/release/linux-unpacked/archivist`, AppImage/deb) wurde lokal gebaut und mit dem kompletten E2E-Test geprüft.
- macOS (`dist:mac`) ist konfiguriert, aber hier nicht getestet.

## Bewusste Abweichungen und ehrliche Grenzen

- **LLM-Client**: ein typisierter Fetch-Client statt des offiziellen OpenAI-SDKs – volle Kontrolle über Timeouts, Fallbacks für Azure-/kompatible Endpunkte und keine zusätzliche Abhängigkeit. Das Responses-API-Format ist identisch.
- **Vektorsuche**: `sqlite-vec` wird **nicht** verwendet (Packaging-Risiko über Plattformen hinweg). Stattdessen: Embeddings als BLOB in SQLite, Cosine-Ähnlichkeit im Worker-Thread. Ohne konfiguriertes Embedding-Modell nutzt Archivist **lokale Feature-Hashing-Vektoren** (Wörter + Zeichen-Trigramme): offline, deterministisch und für vertrauliche Dokumente geeignet, aber lexikalisch-morphologisch und kein echtes semantisches Modell. Mit konfiguriertem Embedding-Modell (`/embeddings`) werden zusätzlich echte Embeddings verwendet (sofern der Datenschutzmodus es erlaubt).
- **XLSX**: Ein eigener, kleiner ZIP/XML-Leser statt SheetJS (die auf npm verfügbare Version hat bekannte, ungepatchte Schwachstellen). Er liest Tabellenblätter als Text; Datumszellen erscheinen als Excel-Seriennummer, Formeln nur mit ihrem zuletzt gespeicherten Wert.
- **OCR**: eingebaut und standardmäßig aktiv (Einstellungen → Archiv). Bilder (PNG/JPG) und PDFs ohne Textebene (Scans) werden lokal mit `tesseract.js` erkannt – Worker, WASM-Kern und Sprachdaten (Deutsch + Englisch, Pakete `@tesseract.js-data/*`) liegen im Installationspaket, es wird **nichts aus dem Netz geladen**. Die Sprachdaten werden beim ersten Einsatz nach `index/tessdata/` kopiert; weitere Sprachen: `ocr.languages` (z. B. `deu+eng`, Paket `@tesseract.js-data/<code>` muss installiert sein). Bilder werden vor der Erkennung gedreht, kontrastiert und ggf. vergrößert; PDFs werden seitenweise gerendert (max. 40 Seiten). Bei Fehlern wird der Grund sichtbar gemeldet und die Datei trotzdem archivierbar gehalten.
- **Hintergrundbetrieb**: Scans, Erinnerungen und Archivprüfungen laufen nur, **solange Archivist geöffnet ist**. Es gibt keinen Tray-Prozess, Autostart oder Betriebssystemdienst; die Anwendung behauptet nichts anderes.
- **Archivpfad ändern**: Der Pfad in den Einstellungen wird validiert, bestehende Dateien werden aber *nicht* automatisch verschoben (Archivist reorganisiert nie unkontrolliert).
- **Löschen** (Stufe 3) ist bewusst nicht implementiert.
- Die Widerspruchserkennung ist zurückhaltend: lexikalische Gegensätze (z. B. weiterführen vs. pausieren, unterschiedliche Auswahl „für X/Y“) plus optionale LLM-Bestätigung – es sind **Hinweise**, keine festgestellten Wahrheiten.
- Die Oberfläche ist ausschließlich Deutsch.

## Fehlerbehebung

| Symptom | Ursache / Lösung |
| --- | --- |
| „Sicherer Speicher nicht verfügbar“ (Linux) | libsecret/kwallet bzw. ein laufender Schlüsselbund-Dienst fehlt (`gnome-keyring`). Archivist speichert den Key nie im Klartext. |
| „Ein natives Modul passt nicht zur Laufzeitumgebung“ | `npm install` erneut ausführen und `npm run native:check` prüfen. |
| LLM-Test: „nicht erreichbar“ | Base URL/Proxy/Firewall prüfen; Logs unter `…/Archivist/logs/`. |
| LLM-Test: „Endpunkt oder Modell nicht gefunden“ | Base URL muss auf die API-Wurzel (z. B. `…/openai/v1`) zeigen, Modellname exakt wie im Deployment. |
| Electron startet unter Linux als root nicht | Mit `--no-sandbox` starten (nur in Containern) oder als normaler Benutzer ausführen. |

Lizenz: MIT (siehe `LICENSE`).
