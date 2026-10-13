# Mitmachen

Danke, dass du hilfst. Archivist ist eine Electron-App mit Next.js und TypeScript; die [Dokumentation](docs/README.md) erklärt, wie sie funktioniert.

## Einrichten

Node.js ≥ 22 und npm ≥ 10:

```bash
npm install            # alle Workspaces, inkl. Electron
npm run native:check   # native Module in Node und Electron
```

Ausführlich: [Entwicklungsumgebung aufsetzen](docs/tutorials/entwicklungsumgebung.md).

## Arbeiten

| Aufgabe | Befehl |
| --- | --- |
| App mit Hot Reload | `npm run dev` |
| Alle Unit- und Integrationstests | `npm test` |
| Eine Testdatei | `npx vitest run tests/unit/agent-adapters.test.ts` |
| Typen, Lint, Format | `npm run typecheck`, `npm run lint`, `npm run format` |
| Architekturgrenzen, toter Code | `npm run depcruise`, `npm run knip` |
| E2E gegen die gebaute App | `npm run build && xvfb-run -a npx playwright test` (unter Windows ohne `xvfb-run`) |
| Migration aus Schemaänderungen | `npm run db:generate` |

Alle Befehle: [npm-Befehle](docs/reference/befehle.md). Tests laufen gegen echtes SQLite und das Fake-LLM, nie gegen ein echtes Modell. Eine UI-Änderung bekommt einen Playwright-Fall über die Page Objects in `tests/e2e/pages/`, eine fachliche Änderung einen Vitest-Test, der Verhalten prüft ([Tests und Qualitätssicherung](docs/reference/qualitaetssicherung.md)).

## Bevor du einen Pull Request öffnest

```bash
npm run typecheck
npm run format:check
npm run lint
npm run depcruise
npm run knip
npm run test:coverage
npm run build && xvfb-run -a npx playwright test
npm run native:check      # wenn du Electron oder native Module angefasst hast
prek run --all-files      # gitleaks, zizmor, Dateihygiene
```

- Ein Thema je Pull Request.
- Die Dokumentation wandert mit dem Code: Verhalten → Referenz, neuer Ablauf → Anleitung; was an das LLM geht oder gespeichert wird, auch in [Datenschutz einstellen](docs/how-to/datenschutz-einstellen.md) und [LLM-Schnittstelle](docs/reference/llm-schnittstelle.md).
- Was Benutzer sehen, ist Deutsch und spricht mit „du“; was programmiert ist, ist Englisch ([Texte und Ansprache](docs/reference/texte-und-ansprache.md)).
- Das [Sicherheitsmodell](docs/explanation/sicherheitsmodell.md) bleibt unangetastet: keine Datei geht verloren, Bestätigungen erzwingt das Schema, Dokumente sind Daten, keine Anweisungen.

Die CI führt alle Prüfungen aus (`ci.yml`, `codeql.yml`) und baut das Windows-Paket; Mutationstests laufen nur auf `main` (`mutation.yml`).

## Veröffentlichen

Änderungen stehen in den [GitHub Releases](https://github.com/besessener/Archivist/releases). Version erhöhen, mergen, taggen und pushen; den Rest erledigt `release.yml`. Schritt für Schritt: [Windows-Paket bauen und Release veröffentlichen](docs/how-to/release-veroeffentlichen.md).

## Erweitern

- Ein neuer IPC-Kanal: Input- und Output-Schema in `packages/shared/src/ipc.ts`, siehe [Architektur](docs/explanation/architektur.md#ein-vertrag-für-alles).
- Eine Schemaänderung: [Datenbankschema ändern](docs/how-to/datenbankschema-aendern.md).
- Ein neues Werkzeug für den Agenten: [Archivist als Agent](docs/explanation/agent.md#werkzeuge-statt-sonderfälle) und [Agentenmodus](docs/reference/agentenmodus.md).
