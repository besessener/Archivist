# npm-Befehle

Alle Befehle werden im Wurzelverzeichnis ausgeführt.

## Entwickeln und bauen

| Befehl | Wirkung |
| --- | --- |
| `npm install` | installiert alle Workspaces (inkl. Electron) |
| `npm run dev` | Next.js-Dev-Server + Electron mit Hot Reload |
| `npm run build` | Renderer (`next build` → `out/`) + Main/Preload/Worker/Lese-Worker (esbuild → `apps/desktop/dist`) |
| `npm run start` | baut und startet die gebündelte App |
| `npm run dist` | Windows: NSIS-Installer + portable EXE nach `apps/desktop/release/` |
| `npm run dist:win` | dasselbe (Alias) |
| `npm run release:win` | baut und veröffentlicht ein GitHub Release (nur in der CI), siehe [Release veröffentlichen](../how-to/release-veroeffentlichen.md) |
| `npm run pack -w archivist` | packt die App ohne Installer (für E2E gegen die gepackte App) |
| `npm run db:generate` | Drizzle-Migration aus Schemaänderungen erzeugen |
| `npm run native:check` | prüft die nativen Module in Node **und** in der Electron-Laufzeit |

## Prüfen

| Befehl | Wirkung |
| --- | --- |
| `npm run typecheck` | `tsc` strict in allen Workspaces + Tests |
| `npm run lint` | ESLint (typescript-eslint, `--max-warnings 0`) |
| `npm test` | Vitest: Unit- und Integrationstests |
| `npm run test:watch` | Vitest im Watch-Modus |
| `npm run test:coverage` | Tests mit Coverage, Bericht in `coverage/` |
| `npm run test:e2e` | baut und startet Playwright gegen die Electron-App; in der CI (Ubuntu) headless mit `xvfb-run -a` |
| `npm run test:mutation` | Mutationstests mit Stryker (lokal nur für geänderte Dateien, z. B. `npx stryker run --mutate <Datei>`, nie vollständig) |
| `npm run mutation:file -- <Datei>` | Schneller lokaler Mutationslauf für eine Quelldatei, nur mit den Tests, die sie (auch über eine andere Quelldatei) importieren; Sekunden bis Minuten statt Stunden. Statische Mutanten treffen dabei weniger Tests als in CI, der Wert ist ein Richtwert |
| `npm run mutation:summary` | Zusammenfassung der Mutationstests |
| `npm run eval:agent` | Agent-Evaluation mit echten Modellen – **kostet Geld**, siehe [Den Agenten evaluieren](../how-to/agent-evaluieren.md) |
| `npm run format` / `format:check` | Prettier schreiben bzw. prüfen |
| `npm run depcruise` | Architekturgrenzen prüfen (dependency-cruiser) |
| `npm run knip` | toten Code finden |

E2E lokal: `npm run build && xvfb-run -a npx playwright test` (unter Windows ohne `xvfb-run`).
