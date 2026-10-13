# Archivist-Dokumentation

Die Dokumentation folgt [Diátaxis](https://diataxis.fr/): Sie ist nach dem geordnet, was du gerade brauchst.

|  | Zum Lernen | Für die Arbeit |
| --- | --- | --- |
| **Praxis** | [Tutorials](#tutorials) – Schritt für Schritt zum ersten Erfolg | [Anleitungen](#anleitungen) – ein konkretes Ziel erreichen |
| **Wissen** | [Hintergrund](#hintergrund) – verstehen, warum es so ist | [Referenz](#referenz) – nachschlagen, wie es genau ist |

## Tutorials

- [Erste Schritte mit Archivist](tutorials/erste-schritte.md) – einrichten, ein Dokument archivieren, eine Entscheidung festhalten und wiederfinden.
- [Entwicklungsumgebung aufsetzen](tutorials/entwicklungsumgebung.md) – vom Klonen bis zum ersten grünen Testlauf.

## Anleitungen

**Archivist benutzen**

- [LLM-Anbieter verbinden](how-to/llm-anbieter-verbinden.md) – Responses API oder Anthropic Messages API, Verbindung testen.
- [Verzeichnisse scannen](how-to/verzeichnisse-scannen.md) – Dateien aus vorhandenen Ordnern bekannt machen.
- [Ablage prüfen und Dokumente umlagern](how-to/dokumente-umlagern.md) – verstreute Dokumente eines Themas zusammenführen.
- [Hauptkategorien auf Deutsch umstellen](how-to/hauptkategorien-umbenennen.md) – `work` und `private` einmalig umbenennen.
- [Verknüpfungsvorschläge prüfen](how-to/verknuepfungen-pruefen.md) – Vorschläge annehmen, ablehnen oder selbst verknüpfen.
- [Datenschutz einstellen](how-to/datenschutz-einstellen.md) – festlegen, was an den LLM-Endpunkt gehen darf.
- [Spracheingabe einrichten und nutzen](how-to/spracheingabe-einrichten.md) – im Chat diktieren, lokal mit Whisper.
- [Archivpfad ändern](how-to/archivpfad-aendern.md) – das Archiv umziehen oder einen anderen Ordner verwenden.
- [Backups anlegen](how-to/backups-anlegen.md) – von Hand oder automatisch sichern.
- [Backup wiederherstellen](how-to/backup-wiederherstellen.md) – Datenbank und fehlende Archivdateien zurückholen.
- [Fehlerbehebung](how-to/fehlerbehebung.md) – Symptome, Ursachen und Lösungen.

**Archivist entwickeln**

- [Mitmachen](../CONTRIBUTING.md) – einrichten, arbeiten, Pull Request öffnen, veröffentlichen.
- [Datenbankschema ändern](how-to/datenbankschema-aendern.md) – Tabellen ändern, Migration erzeugen und prüfen.
- [Den Agenten mit echten Modellen evaluieren](how-to/agent-evaluieren.md) – `npm run eval:agent`, kostet Geld.
- [Windows-Paket bauen und Release veröffentlichen](how-to/release-veroeffentlichen.md) – lokal bauen, signieren und veröffentlichen.
- [Webseite pflegen und veröffentlichen](how-to/webseite-pflegen.md) – `site/`, Screenshots und der Pages-Workflow.

## Referenz

- [Funktionen im Detail](reference/funktionen.md) – genaues Verhalten jedes Funktionsbereichs.
- [Agentenmodus](reference/agentenmodus.md) – Anbieter, Modi, Agentenläufe und Werkzeuge.
- [Aktionsstufen und Schutzregeln](reference/aktionsstufen.md) – was ohne Rückfrage geht, was Bestätigung braucht.
- [LLM-Schnittstelle](reference/llm-schnittstelle.md) – wie Archivist mit dem LLM-Endpunkt spricht.
- [Konfiguration und Umgebungsvariablen](reference/konfiguration.md) – `settings.json` und Umgebungsvariablen.
- [Datenverzeichnis](reference/datenverzeichnis.md) – wo deine Dokumente und der Zustand der App liegen.
- [npm-Befehle](reference/befehle.md) – alle Skripte im Wurzelverzeichnis.
- [Projektstruktur und Services](reference/projektstruktur.md) – Verzeichnisse, wichtige Dateien, Services und Fehlerkategorien.
- [Tests und Qualitätssicherung](reference/qualitaetssicherung.md) – Vitest, Playwright, Agent-Evaluation und CI.
- [Packaging](reference/packaging.md) – Zielplattform, native Module, Bündelung und Signierung.
- [Texte und Ansprache](reference/texte-und-ansprache.md) – wie Archivist schreibt und dich anspricht.
- [Gestaltung der Oberfläche](reference/gestaltung.md) – Farben, Flächen und Hervorhebungen.

## Hintergrund

- [Architektur](explanation/architektur.md) – ein Vertrag für alles, Services ohne Electron, freier Main-Prozess.
- [Sicherheits- und Datenschutzmodell](explanation/sicherheitsmodell.md) – drei Risiken und wie Archivist sie eindämmt.
- [Archivist als Agent](explanation/agent.md) – Werkzeuge statt Sonderfälle, nachvollziehbares Handeln, Grenzen.
- [Wie die Suche funktioniert](explanation/suche.md) – Stichwort- und Vektorsuche, zusammengeführt.
- [Wie Archivist Wissen verknüpft](explanation/verknuepfungen.md) – der Wissensgraph und warum Archivist nur vorschlägt.
- [Bewusste Abweichungen und ehrliche Grenzen](explanation/grenzen.md) – was anders gebaut ist und was Archivist bewusst nicht kann.

Verwandte Projekte mit derselben Idee und demselben Aufbau der Dokumentation:
[PlayMonkey](https://github.com/besessener/PlayMonkey/blob/main/docs/README.md) und
[flakipype](https://github.com/besessener/flakipype/blob/main/docs/README.md).
