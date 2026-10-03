# Tests und Qualitätssicherung

## Vitest (`npm test`)

Unit- und Integrationstests laufen gegen eine echte SQLite-Datenbank und einen Fake-LLM-Endpunkt. Abgedeckt sind u. a.:

Decision-Rückfragen, Agentenläufe gegen beide Anbieter-Formate (OpenAI Responses, Anthropic Messages), Zod-Validierung von LLM-Ausgaben, IPC-Eingabevalidierung, Pfadnormalisierung, Path-Traversal, Symlink-Ausbruch, Scan-Bereichsgrenzen, Datei-Ausschlüsse, Duplikaterkennung, Bestätigungsworkflows, Archivieren durch Kopieren/Verschieben, Undo (inkl. Konflikte), Datenbankmigrationen (inkl. Konsistenz von Journal, SQL-Dateien und Snapshots, siehe [Datenbankschema ändern](../how-to/datenbankschema-aendern.md)), Job-Queue nach Neustart, Widerspruchserkennung mit kontrollierten Beispielen, Maskierung von Schlüsseln in Logs, Verhalten bei nicht erreichbarem LLM, Worker-Threads, Backups, Renderer-Auslieferung/CSP.

**Coverage**: `npm run test:coverage` (Bericht in `coverage/`). Die Schwellen in `vitest.config.mts` liegen knapp unter dem Ist-Wert und werden nur angehoben, nie gesenkt.

## Playwright (`tests/e2e`)

- Jeder Test startet die echte Electron-App mit frischem Datenordner und einem lokalen Fake-LLM-HTTP-Server.
- Aufgeteilt nach Funktionen: Einrichtung, Import/Archivierung, OCR, Chat-Entscheidungen, Chat-Eingabe, Agentenmodus, Timeline, Scan.
- Der Fake-LLM-Server antwortet nur dann mit Werkzeugaufrufen, wenn eine Spec Agenten-Runden vorgibt (`llm.agentTurns`); alle anderen Specs laufen über den regelbasierten Chat.
- Page Objects (`tests/e2e/pages`) mit `locators` und `do`, sodass die Specs wie eine Beschreibung des Verhaltens lesen.
- `accessibility.spec.ts` prüft jeden Bereich der Navigation mit axe-core (WCAG 2.2 AA); schwere und kritische Verstöße lassen den Test fehlschlagen.
- Lokal: `npm run build && xvfb-run -a npx playwright test` (unter Windows ohne `xvfb-run`).

## Agent-Evaluation (`tests/eval`)

Mit echten Modellen, nicht Teil von `npm test` und der CI: [Den Agenten evaluieren](../how-to/agent-evaluieren.md).

## CI

| Prüfung | Wo |
| --- | --- |
| Secret-Scan über die gesamte Historie (gitleaks, Konfiguration `.gitleaks.toml`) | `hygiene`-Job; lokal als pre-commit-Hook |
| Hygiene-Hooks (YAML/JSON, Merge-Konflikte, private Schlüssel, große Dateien) und Workflow-Linter zizmor | `.pre-commit-config.yaml`; lokal mit `pip install pre-commit && pre-commit install` (oder `prek install`) |
| Typecheck, ESLint (type-aware, `jsx-a11y`, `sonarjs` mit kognitiver Komplexität höchstens 15 je Funktion, `--max-warnings 0`), Vitest mit Coverage-Schwellen, Build, Electron-E2E, Windows-Installer | `test`- bzw. `windows-installer`-Job |
| Formatierung (Prettier), Architekturgrenzen (dependency-cruiser: Renderer kennt nur `shared`, Core ohne Electron/UI, keine Laufzeit-Zyklen), toter Code (Knip) | `test`-Job; lokal `npm run format`, `npm run depcruise`, `npm run knip` |
| Statische Sicherheitsanalyse (CodeQL, `security-extended`; Ergebnisse unter Security → Code scanning) | `codeql.yml`, bei PR, Push auf `main` und wöchentlich |
| Mutationstests (Stryker) auf den Modulen in `mutation-targets.mjs`: Pfadsicherheit, Maskierung, Datenschutzfilter, Undo, Agenten-Gate und Sicherheitsregeln, Verlaufsfilter sowie reine Fachregeln (Namensschema, Felder von Entscheidungen und offenen Punkten, Fristen, Beträge, Widerspruchsregeln, Base-URL-Regel); Schwellen in `stryker.config.mjs` | `mutation.yml` (nicht in Pull Requests; bei Push auf `main` inkrementell, täglich vollständig); lokal `npm run test:mutation` |
| Aktualisierung von Actions, Hook-Revisionen und npm-Abhängigkeiten | Dependabot (`.github/dependabot.yml`); Electron und native Module werden nie automatisch gemergt |

Unit-, Integrations- und E2E-Tests laufen auf Ubuntu (schnell und günstig); gepackt wird ausschließlich auf `windows-latest`.

**Workflow-Härtung**: Alle Actions sind auf Commit-SHAs gepinnt (Kommentar nennt den Tag), Workflows laufen standardmäßig ohne Token-Rechte (`permissions: {}`) und mit `persist-credentials: false`.
