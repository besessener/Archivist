# Archivist

***Archivist – dein persönlicher Archivar***

Archivist ist ein persönlicher, agentischer KI-Archivar für genau einen Benutzer: eine lokale Desktop-Anwendung für Windows (Electron + Next.js + TypeScript), die Dokumente, Entscheidungen, offene Punkte und Wissen nicht nur speichert, sondern versteht, verknüpft und das Archiv aktiv konsistent hält.

- **Chat als Schnittstelle** – Entscheidungen festhalten, Fragen stellen, Antworten mit Quellen.
- **Sicheres Archivieren** – Dokumente landen in menschenlesbaren Ordnern; nichts wird überschrieben, Gelöschtes landet im Papierkorb, alles ist rückgängig machbar.
- **Wissensgraph und hybride Suche** – Themen, Projekte, Personen und Dokumente sind verknüpft und auffindbar; Archivist schlägt Verknüpfungen mit Begründung vor, du entscheidest.
- **Agent** – plant mehrere Schritte, nutzt Werkzeuge und prüft das Archiv im Hintergrund auf Lücken, Dubletten und Widersprüche.
- **Lokal und datensparsam** – alle Daten bleiben auf deinem Rechner; nach außen geht nur, was du dem konfigurierten LLM-Endpunkt freigibst.

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

Die vollständige Dokumentation liegt unter [`docs/`](docs/README.md), gegliedert nach [Diátaxis](https://diataxis.fr/):

- **[Tutorials](docs/README.md#tutorials)** – Schritt für Schritt zum ersten Erfolg
- **[Anleitungen](docs/README.md#anleitungen)** – konkrete Aufgaben lösen, z. B. [LLM-Anbieter verbinden](docs/how-to/llm-anbieter-verbinden.md) oder [Release veröffentlichen](docs/how-to/release-veroeffentlichen.md)
- **[Referenz](docs/README.md#referenz)** – genaues Verhalten nachschlagen, z. B. [Funktionen](docs/reference/funktionen.md) oder [Aktionsstufen](docs/reference/aktionsstufen.md)
- **[Hintergrund](docs/README.md#hintergrund)** – verstehen, warum es so ist, z. B. [Architektur](docs/explanation/architektur.md) oder [Sicherheitsmodell](docs/explanation/sicherheitsmodell.md)

## Lizenz

MIT, siehe [LICENSE](LICENSE).
