# Erste Schritte mit Archivist

In diesem Tutorial richtest du Archivist ein, archivierst dein erstes Dokument, hältst eine Entscheidung fest und findest sie anschließend wieder. Du brauchst etwa 15 Minuten.

**Du brauchst**

- einen Windows-Rechner mit installiertem Archivist (NSIS-Installer oder portable EXE aus den [GitHub Releases](https://github.com/besessener/Archivist/releases)),
- Zugang zu einem LLM-Endpunkt – z. B. Azure OpenAI, Claude über die Anthropic API oder Microsoft Foundry – mit Base URL, API-Key und Modellname,
- ein beliebiges Dokument, z. B. ein PDF.

## 1. Einrichten

Starte Archivist. Beim ersten Start öffnet sich der Einrichtungsdialog.

1. Trag deinen Namen ein. Archivist weiß damit, wer „ich“ ist.
2. Trag **Base URL**, **API-Key** und **Modell** ein und klick auf **Verbindung testen**. Der Test prüft Text, strukturierte Antworten und einen echten Werkzeugaufruf. Schlägt er fehl, hilft die [Fehlerbehebung](../how-to/fehlerbehebung.md).
3. Scan-Verzeichnisse kannst du überspringen – das holst du später mit [Verzeichnisse scannen](../how-to/verzeichnisse-scannen.md) nach.
4. Lass den Datenschutzmodus auf **Vor externer Analyse bestätigen** (`confirm`). So siehst du bei jedem Schritt, was das Modell zu sehen bekommt.

Der API-Key wird verschlüsselt gespeichert, nie im Klartext.

## 2. Ein Dokument archivieren

1. Zieh dein PDF in das Archivist-Fenster.
2. Archivist kopiert es in den Eingang, liest den Text aus und fragt – wegen des Modus `confirm` – ob es zur Analyse an das LLM gehen darf. Bestätige.
3. Öffne die **Inbox**. Dort steht dein Dokument mit vorgeschlagener Kategorie und einem lesbaren Zielpfad wie `Arbeit/Projekte/prod-plat/`.
4. Prüf Quell- und Zielpfad und bestätige.

Dein Dokument liegt jetzt als Kopie unter `~/Documents/Archivist/archive/…`. Das Original ist unverändert. Willst du es doch nicht archiviert haben, findest du die Aktion unter Einstellungen → Änderungsprotokoll mit **Rückgängig**.

## 3. Eine Entscheidung festhalten

Wechsel in den **Chat** und schreib:

> Wir haben entschieden, dass wir mit prod-plat erstmal nicht weitermachen.

Archivist erkennt eine Entscheidung und fragt nach dem, was noch fehlt: wann, wer beteiligt war, welches Thema. Beantworte die Rückfragen. Erst wenn alle Pflichtfelder gefüllt sind (oder du ausdrücklich „unbekannt“ sagst), wird die Entscheidung endgültig gespeichert.

## 4. Wiederfinden

Frag im Chat:

> Wann haben wir prod-plat pausiert?

Die Antwort nennt das Datum und verweist auf ihre Quelle – deine Entscheidung von eben. Öffne die **Timeline**: Dort steht die Entscheidung an ihrem Datum.

## Geschafft

Du hast ein Dokument sicher archiviert, eine Entscheidung vollständig erfasst und mit Quelle wiedergefunden. Als Nächstes:

- [Verzeichnisse scannen](../how-to/verzeichnisse-scannen.md), damit Archivist bestehende Ordner kennt,
- [Ablage prüfen und Dokumente umlagern](../how-to/dokumente-umlagern.md),
- [Archivist als Agent](../explanation/agent.md) verstehen – was er selbst erledigt und wo er fragt.
