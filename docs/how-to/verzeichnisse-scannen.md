# Verzeichnisse scannen

So machst du Archivist mit Dateien bekannt, die bereits in Ordnern auf deinem Rechner liegen, z. B. `~/Downloads`.

1. Öffne **Scan** und gib ein Verzeichnis frei. Wurzeln (`C:\`), Systemverzeichnisse und Verzeichnisse anderer Benutzer werden abgelehnt.
2. Soll der Inhalt dieses Ordners nie an das LLM gehen, schalte bei diesem Verzeichnis **KI-Analyse erlaubt** aus.
3. Klick auf **Jetzt nach neuen Dokumenten suchen**. Der erste Schritt ist rein technisch und läuft ohne LLM: Dateien auflisten, Prüfsummen bilden, Duplikate erkennen.
4. Wähl die Dateien aus, die analysiert werden sollen, und starte die Analyse.
5. Prüf die **Zuordnungsvorschläge** und bestätige sie. Erst dann wird archiviert – standardmäßig als Kopie.

## Automatisch scannen

Unter **Scan** schaltest du **Beim Start der App suchen** und **Regelmäßig suchen** ein. Das funktioniert nur, **solange Archivist läuft** – es gibt keinen Hintergrunddienst. Änderungen an Zeitplan und Ordnern wirken sofort.

## Was beim Scannen passiert – und was nicht

- Bekannte, unveränderte Dateien (Größe + Änderungszeit) werden weder neu gehasht noch analysiert.
- Dateien, deren Inhalt bereits im Eingang oder Archiv liegt, werden als Duplikat markiert.
- Versteckte Einträge, `node_modules` und das Archivist-Datenverzeichnis werden übersprungen; Symlinks nur verfolgt, wenn ihr Ziel im freigegebenen Bereich liegt.
- Es gibt keine Obergrenze für die Zahl der Dateien pro Freigabe. Die Ergebnisliste zeigt zunächst 500 Dateien; „Mehr laden“ holt die nächsten.

Alle Regeln: [Funktionen – Verzeichnisscan](../reference/funktionen.md#verzeichnisscan) und [Aktionsstufen und Schutzregeln – Scans](../reference/aktionsstufen.md#scans).

## Dateien ausschließen

Einzelne Dateien, Dateitypen oder Ordner schließt du dauerhaft unter **Einstellungen → Datenschutz → Nie analysieren** aus, siehe [Datenschutz einstellen](datenschutz-einstellen.md).
