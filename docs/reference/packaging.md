# Packaging

Bauen und veröffentlichen: [Windows-Paket bauen und Release veröffentlichen](../how-to/release-veroeffentlichen.md).

## Zielplattform

Nur **Windows** (NSIS-Installer mit Auswahl des Installationsverzeichnisses + portable EXE). Linux- und macOS-Pakete werden nicht gebaut.

## Native Module

- `better-sqlite3` (≥ 13) und `sharp` liefern **N-API-Prebuilds** für Windows; dieselbe Binärdatei läuft in Node und Electron.
- Ein `electron-rebuild` ist deshalb nicht nötig (`npmRebuild: false`); das Cross-Packaging ist reproduzierbar.
- `npm run native:check` beweist das für Node *und* die Electron-Laufzeit.
- In der Anwendung liegen die Module per `asarUnpack` außerhalb des ASAR-Archivs.
- `onnxruntime-node` (Spracheingabe, über `@huggingface/transformers`) liefert ebenfalls N-API-Prebuilds. Im Paket bleiben nur die Windows-x64-Binärdateien (die anderen Plattformen und `onnxruntime-web` schließt `electron-builder.yml` aus, das spart mehrere hundert MB). Die `.npmrc` setzt `onnxruntime-node-install=skip`, damit `npm install` unter Linux keine CUDA-Bibliotheken nachlädt; Archivist rechnet nur auf der CPU.

## Bündelung

- **Gebündelt** (esbuild): Main, Preload, Worker (`worker.cjs`, `db-reader.cjs`, `speech-worker.cjs`), alle reinen JS-Abhängigkeiten.
- **Extern** (werden mitgeliefert): `better-sqlite3`, `sharp`, `pdfjs-dist`, `@huggingface/transformers` (mit `onnxruntime-node`).
- OCR-Worker, WASM-Kern und Sprachdaten (`@tesseract.js-data/*`) liegen im Installationspaket.

## Speicherorte der installierten App

- Dokumentenordner (Archiv, Eingang, Quarantäne, Papierkorb): `Dokumente\Archivist`.
- Anwendungsdaten (Datenbank, Index, Einstellungen, Protokolle, Backups): `%APPDATA%\Archivist` (Electron-`userData`; Name aus `productName`). Das gilt für Installer und portable EXE gleichermaßen; die Deinstallation entfernt diesen Ordner nicht.
- Beim ersten Start nach einem Update aus einer Version, die alles in `Dokumente\Archivist` hielt, zieht Archivist die Anwendungsdaten automatisch um, siehe [Datenverzeichnis](datenverzeichnis.md#umzug-aus-der-alten-ablage).
- `ARCHIVIST_DATA_DIR` legt weiterhin alles unter einen Ordner.

## App-ID

- `io.github.besessener.archivist` – Reverse-DNS von `besessener.github.io`; die Domain gehört dem Projekt über GitHub.
- Der NSIS-Installer setzt sie als AppUserModelID der Verknüpfungen, und die App setzt beim Start dieselbe ID. Nur dann zeigt Windows Desktop-Benachrichtigungen.
- In der Entwicklung (`npm run dev`) gilt `electron.exe` als App: Für Benachrichtigungen dort `node_modules\electron\dist\electron.exe` an „Start“ anheften.
- Die ID darf nach der ersten Verteilung nicht mehr geändert werden, sonst funktionieren stille Updates bestehender Installationen nicht mehr.

## Releases

- Workflow: `.github/workflows/release.yml`, ausgelöst durch einen Versions-Tag `v1.2.3`.
- Versionen in `package.json` und `apps/desktop/package.json` müssen zum Tag passen (`scripts/check-release-version.mjs`).
- Veröffentlicht über electron-builder `--publish always`, Provider `github`.
- Tags mit Zusatz (`v1.2.3-beta.1`) erscheinen als Vorabversion.
- Auto-Update (`electron-updater`): `publishAutoUpdate: true` lädt zusätzlich `latest.yml` und die Blockmaps hoch. Die installierte Version (NSIS) liest daraus das neueste Release; Vorabversionen und Commits auf `main` beachtet sie nicht. Die portable EXE aktualisiert sich nicht selbst. Bedienung: [Funktionen](funktionen.md#updates).

## Signierung

- Authenticode (SHA-256, RFC-3161-Zeitstempel) für Installer und portable EXE.
- Lokal: `CSC_LINK`, `CSC_KEY_PASSWORD`. CI: Secrets `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`; Prüfung mit `Get-AuthenticodeSignature`.
- Ohne Zertifikat unsigniert (SmartScreen-Warnung).
