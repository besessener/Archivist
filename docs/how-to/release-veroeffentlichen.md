# Windows-Paket bauen und Release veröffentlichen

Gepackt wird ausschließlich für Windows. Hintergründe zu nativen Modulen und Bündelung: [Packaging](../reference/packaging.md).

## Lokal bauen

```bash
npm run dist:win       # NSIS-Installer + portable EXE nach apps/desktop/release/
```

Der letzte Schritt (Ressourcen-Bearbeitung/Signierung der `.exe`) braucht **Windows oder Wine**. Auf einem Linux-Host ohne Wine bricht electron-builder dort ab (Download, ASAR-Paketierung und NSIS-Toolchain laufen bis dahin). Die CI baut den Installer deshalb auf `windows-latest`.

## Release veröffentlichen

1. Erhöhe die Version in `package.json` **und** `apps/desktop/package.json`.
2. Merge auf `main`.
3. Tagge und pushe:

   ```bash
   git tag v1.2.3 && git push origin v1.2.3
   ```

Der Workflow `.github/workflows/release.yml`

- prüft, dass Tag und Versionen übereinstimmen (`scripts/check-release-version.mjs`),
- führt Typecheck, Lint und Tests aus,
- ruft auf `windows-latest` `npm run release:win` auf (electron-builder `--publish always`, Provider `github`, `GITHUB_TOKEN` mit `contents: write`),
- veröffentlicht Installer und portable EXE als **GitHub Release**.

Tags mit Zusatz (`v1.2.3-beta.1`) erscheinen als Vorabversion. Merges auf `main` und Pull Requests bauen die Pakete nur. Auto-Update (`electron-updater`) ist nicht eingerichtet, deshalb werden keine Update-Metadaten hochgeladen.

## Signieren

Installer *und* portable EXE werden per Authenticode (SHA-256, RFC-3161-Zeitstempel) signiert, sobald ein Zertifikat vorliegt.

- **Lokal**: Umgebungsvariablen `CSC_LINK` (Pfad oder Base64 der `.pfx`) und `CSC_KEY_PASSWORD` setzen.
- **CI**: Repository-Secrets `WIN_CSC_LINK` (Base64-kodierte `.pfx`, z. B. `base64 -w0 zertifikat.pfx`) und `WIN_CSC_KEY_PASSWORD` anlegen. Der Job prüft danach mit `Get-AuthenticodeSignature`, dass alle `.exe`-Dateien gültig signiert sind.

Ohne Zertifikat bleiben die Pakete unsigniert und SmartScreen zeigt eine Warnung – der Normalfall für Pull Requests aus Forks. Ein selbstsigniertes Zertifikat ist nur auf Rechnern vertrauenswürdig, in deren Zertifikatsspeicher es importiert wurde; gegen die SmartScreen-Warnung helfen nur ein Zertifikat einer öffentlichen CA bzw. Azure Trusted Signing.

## Die gepackte App prüfen

`npm run pack -w archivist` baut die App ohne Installer nach `apps/desktop/release/`. Die E2E-Tests laufen nur gegen den ungepackten Build: Die Test-Umgebungsvariablen (`ARCHIVIST_TEST_MODE`, `ARCHIVIST_TEST_PICK_DIR`) wirken in einer gepackten App bewusst nicht. Den Start der gepackten App prüfst du von Hand.
