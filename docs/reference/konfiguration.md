# Konfiguration und Umgebungsvariablen

## `settings.json`

Einstellungen liegen in `config/settings.json` im [Datenverzeichnis](datenverzeichnis.md) und werden über die Oberfläche (Einstellungen) gepflegt. Eine vollständige Beispieldatei ohne Zugangsdaten ist [`config.example.json`](../../config.example.json).

| Bereich | Wichtige Felder |
| --- | --- |
| `profile` | `name`, `nicknames` – wer „ich“ ist |
| `llm` | `baseUrl`, `model`, `reasoningEffort`, `timeoutMs`, `maxInputChars`, `embeddingModel` – siehe [LLM-Schnittstelle](llm-schnittstelle.md) |
| `archiveRoot` | Archivordner, siehe [Archivpfad ändern](../how-to/archivpfad-aendern.md) |
| `scan` | `enabled`, `onStartup`, `periodic`, `intervalMinutes`, `maxFileSizeMb`, `allowedExtensions`, `autoAnalyze` |
| `privacy` | `llmMode` (`auto` / `confirm` / `local_only`), `neverAnalyzeDirs`, `neverAnalyzeExtensions`, `neverAnalyzeFiles` |
| `notifications` | `desktop`, `reminderTime` (Standard `08:00`) |
| `logs` | `level`, `retentionDays` |
| `backups` | `keep`, `autoOnStartup`, `includeArchive` |
| `consistency` | `onStartup`, `intervalHours` (0 = aus), `staleOpenItemDays` |
| `ocr` | `enabled`, `languages` (z. B. `deu+eng`) |
| `links` | `autoPropose` (Verknüpfungen automatisch vorschlagen, Standard an), `maxProposalsPerEntry` (offene Ähnlichkeitsvorschläge je Eintrag, 1–10, Standard 3) |

Der API-Key steht **nie** in `settings.json`, sondern verschlüsselt in `config/llm-api-key.enc`.

**Ungültige Werte**: Enthält `settings.json` ungültige Werte, werden nur diese Felder auf ihren Standard gesetzt; alle übrigen Einstellungen bleiben erhalten. Die Originaldatei wird vorher als `settings.json.invalid-<Zeit>` gesichert (ist sie kein gültiges JSON, als `settings.json.corrupt-<Zeit>`), und eine Benachrichtigung nennt die betroffenen Felder.

**Zeitpläne** (Scan-Einstellungen, freigegebene Ordner, Intervall der Archivprüfung) wirken sofort, ohne Neustart.

## Umgebungsvariablen

Archivist liest **keine** `.env`-Dateien automatisch. Die Variablen werden vor dem Start gesetzt; dokumentiert in [`.env.example`](../../.env.example).

| Variable | Zweck |
| --- | --- |
| `ARCHIVIST_DATA_DIR` | Datenverzeichnis (Standard: `~/Documents/Archivist`) |
| `ARCHIVIST_LLM_API_KEY` | nur Entwicklung/CI: API-Key aus der Umgebung statt aus dem sicheren Speicher – nie committen |
| `ARCHIVIST_DEV_URL` | nur Entwicklung: Next.js-Dev-Server statt gebündeltem Frontend (setzt `npm run dev` automatisch) |
| `ARCHIVIST_TEST_MODE` | nur Tests: erlaubt unter Linux ohne Keyring den unsicheren `basic_text`-Fallback von `safeStorage` |
| `ARCHIVIST_TEST_PICK_DIR` | nur Tests: ersetzt den nativen Ordnerauswahl-Dialog |
| `ARCHIVIST_E2E_PACKAGED` | nur Tests: E2E-Tests gegen die gepackte App ausführen |
| `ARCHIVIST_EVAL_*` | Agent-Evaluation, siehe [Den Agenten evaluieren](../how-to/agent-evaluieren.md#1-anbieter-konfigurieren) |
| `CSC_LINK`, `CSC_KEY_PASSWORD` | Code-Signierung beim lokalen Packen, siehe [Signieren](../how-to/release-veroeffentlichen.md#signieren) |
