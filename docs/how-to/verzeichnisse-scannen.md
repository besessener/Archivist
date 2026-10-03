# Verzeichnisse scannen

So machst du Archivist mit Dateien bekannt, die bereits in Ordnern auf deinem Rechner liegen, z. B. `~/Downloads`.

1. Öffne **Scan** und gib ein Verzeichnis frei. Wurzeln (`C:\`), Systemverzeichnisse und Verzeichnisse anderer Benutzer werden abgelehnt.
2. Soll der Inhalt dieses Ordners nie an das LLM gehen, schalte bei diesem Verzeichnis **KI-Analyse erlaubt** aus.
3. Klick auf **Jetzt nach neuen Dokumenten suchen**. Der erste Schritt ist rein technisch und läuft ohne LLM: Dateien auflisten, Prüfsummen bilden, Duplikate erkennen.
4. Wähl die Dateien aus, die analysiert werden sollen, und starte die Analyse – oder analysiere mit **Alle N neuen Dateien analysieren** alle neuen Dateien auf einmal: ein Auftrag, eine Einwilligung (mit Zahl und Token-Schätzung), eine Benachrichtigung am Ende, dazwischen eine Fortschrittszeile wie „4.300 von 20.000 analysiert, ca. 2 Std. 5 Min. verbleibend“.
5. Prüf die **Zuordnungsvorschläge** und bestätige sie. Erst dann wird archiviert – standardmäßig als Kopie.

## Automatisch scannen

Unter **Scan** schaltest du **Beim Start der App suchen** und **Regelmäßig suchen** ein. Das funktioniert nur, **solange Archivist läuft** – es gibt keinen Hintergrunddienst. Änderungen an Zeitplan und Ordnern wirken sofort.

## Was beim Scannen passiert – und was nicht

- Bekannte, unveränderte Dateien (Größe + Änderungszeit) werden weder neu gehasht noch analysiert.
- Dateien, deren Inhalt bereits im Eingang oder Archiv liegt, werden als Duplikat markiert. Dateien mit nur leicht geändertem Text (z. B. ein Entwurf) sind keine Duplikate; die Archivprüfung meldet sie als „Ähnlicher Inhalt“ und löscht nichts.
- Versteckte Einträge, `node_modules` und das Archivist-Datenverzeichnis werden übersprungen; Symlinks nur verfolgt, wenn ihr Ziel im freigegebenen Bereich liegt.
- Pro Freigabe werden höchstens 20.000 Dateien erfasst; ein Hinweis meldet, wenn das Limit erreicht ist.

Alle Regeln: [Funktionen – Verzeichnisscan](../reference/funktionen.md#verzeichnisscan) und [Aktionsstufen und Schutzregeln – Scans](../reference/aktionsstufen.md#scans).

## Dateien ausschließen

Einzelne Dateien, Dateitypen oder Ordner schließt du dauerhaft unter **Einstellungen → Datenschutz → Nie analysieren** aus, siehe [Datenschutz einstellen](datenschutz-einstellen.md).
