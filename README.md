# Archivist

***Archivist – dein persönlicher Archivar***

![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/language-TypeScript-3178C6?logo=typescript&logoColor=white)
![Electron](https://img.shields.io/badge/desktop-Electron-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/UI-React-20232a?logo=react&logoColor=white)
![Next.js](https://img.shields.io/badge/framework-Next.js-black?logo=nextdotjs&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/styling-Tailwind%20CSS-06B6D4?logo=tailwindcss&logoColor=white)
![SQLite](https://img.shields.io/badge/database-SQLite-003B57?logo=sqlite&logoColor=white)
![Drizzle](https://img.shields.io/badge/ORM-Drizzle-C5F74F?logo=drizzle&logoColor=black)
![Zod](https://img.shields.io/badge/validation-Zod-3E67B1?logo=zod&logoColor=white)
![ESLint](https://img.shields.io/badge/lint-ESLint-4B32C3?logo=eslint&logoColor=white)
![Prettier](https://img.shields.io/badge/format-Prettier-F7B93E?logo=prettier&logoColor=white)
![SonarJS](https://img.shields.io/badge/code%20smells-SonarJS-4E9BCD?logo=sonar&logoColor=white)
![dependency-cruiser](https://img.shields.io/badge/architecture-dependency--cruiser-orange)
![Knip](https://img.shields.io/badge/dead%20code-Knip-000000?logo=knip&logoColor=white)
![Vitest](https://img.shields.io/badge/tested%20with-Vitest-6E9F18?logo=vitest&logoColor=white)
![Stryker](https://img.shields.io/badge/mutation-Stryker-E74C3C?logo=stryker&logoColor=white)
![Playwright](https://custom-icon-badges.demolab.com/badge/e2e-Playwright-2EAD33?logo=playwright&logoColor=white)
![Gitleaks](https://img.shields.io/badge/secrets-Gitleaks-blue?logo=git&logoColor=white)
![zizmor](https://img.shields.io/badge/workflow%20security-zizmor-blue?logo=githubactions&logoColor=white)
[![CI](https://github.com/besessener/Archivist/actions/workflows/ci.yml/badge.svg)](https://github.com/besessener/Archivist/actions/workflows/ci.yml)
[![Mutation test](https://github.com/besessener/Archivist/actions/workflows/mutation.yml/badge.svg)](https://github.com/besessener/Archivist/actions/workflows/mutation.yml)
[![CodeQL](https://github.com/besessener/Archivist/actions/workflows/codeql.yml/badge.svg)](https://github.com/besessener/Archivist/actions/workflows/codeql.yml)
[![Last commit](https://img.shields.io/github/last-commit/besessener/Archivist)](https://github.com/besessener/Archivist/commits/main)
[![License: MIT](https://img.shields.io/github/license/besessener/Archivist)](LICENSE)

Archivist ist ein persönlicher, agentischer KI-Archivar für genau einen Benutzer: eine lokale Desktop-Anwendung für Windows (Electron + Next.js + TypeScript), die Dokumente, Entscheidungen, offene Punkte und Wissen nicht nur speichert, sondern versteht, verknüpft und das Archiv aktiv konsistent hält.

- **Chat als Schnittstelle** – Entscheidungen festhalten, Fragen stellen, Antworten mit Quellen.
- **Sicheres Archivieren** – Dokumente landen in menschenlesbaren Ordnern; nichts wird überschrieben, Gelöschtes landet im Papierkorb, alles ist rückgängig machbar.
- **Wissensgraph und hybride Suche** – Themen, Projekte, Personen und Dokumente sind verknüpft und auffindbar; Archivist schlägt Verknüpfungen mit Begründung vor, du entscheidest.
- **Agent** – plant mehrere Schritte, nutzt Werkzeuge und prüft das Archiv im Hintergrund auf Lücken, Dubletten und Widersprüche.

## Installation

Lade Installer oder portable EXE aus den [GitHub Releases](https://github.com/besessener/Archivist/releases) und folge dem Tutorial [Erste Schritte](docs/tutorials/erste-schritte.md).

## Entwicklung

Voraussetzungen: Node.js ≥ 22, npm ≥ 10.

```bash
npm install
npm run dev            # Next.js-Dev-Server + Electron mit Hot Reload
npm test               # Unit- und Integrationstests
```

Ausführlich: [Entwicklungsumgebung aufsetzen](docs/tutorials/entwicklungsumgebung.md) und [npm-Befehle](docs/reference/befehle.md).

## Dokumentation

Webseite: <https://besessener.github.io/Archivist/>. Die vollständige Dokumentation liegt unter [`docs/`](docs/README.md), gegliedert nach [Diátaxis](https://diataxis.fr/):

- **[Tutorials](docs/README.md#tutorials)** – Schritt für Schritt zum ersten Erfolg
- **[Anleitungen](docs/README.md#anleitungen)** – konkrete Aufgaben lösen, z. B. [LLM-Anbieter verbinden](docs/how-to/llm-anbieter-verbinden.md) oder [Release veröffentlichen](docs/how-to/release-veroeffentlichen.md)
- **[Referenz](docs/README.md#referenz)** – genaues Verhalten nachschlagen, z. B. [Funktionen](docs/reference/funktionen.md) oder [Aktionsstufen](docs/reference/aktionsstufen.md)
- **[Hintergrund](docs/README.md#hintergrund)** – verstehen, warum es so ist, z. B. [Architektur](docs/explanation/architektur.md) oder [Sicherheitsmodell](docs/explanation/sicherheitsmodell.md)

## Lizenz

MIT, siehe [LICENSE](LICENSE).
