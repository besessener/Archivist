# Windows-Paket bauen und Release veröffentlichen

Gepackt wird ausschließlich für Windows. Hintergründe zu nativen Modulen und Bündelung: [Packaging](../reference/packaging.md).

## Lokal bauen

```bash
npm run dist:win       # NSIS-Installer + portable EXE nach apps/desktop/release/
```

Der letzte Schritt (Ressourcen-Bearbeitung/Signierung der `.exe`) braucht **Windows oder Wine**. Auf einem Linux-Host ohne Wine bricht electron-builder dort ab (Download, ASAR-Paketierung und NSIS-Toolchain laufen bis dahin). Die CI baut den Installer deshalb auf `windows-latest`.

## Release veröffentlichen

1. Erhöhe die Version im Wurzelpaket und in allen Workspaces auf einmal; das aktualisiert auch deren Einträge in `package-lock.json`:

   ```bash
   npm version 1.2.3 --workspaces --include-workspace-root --no-git-tag-version
   ```

2. Merge auf `main`.
3. Tagge und pushe:

   ```bash
   git tag v1.2.3 && git push origin v1.2.3
   ```

Der Workflow `.github/workflows/release.yml`

- prüft, dass Tag und Versionen übereinstimmen (`scripts/check-release-version.mjs`),
- führt Typecheck, Lint und Tests aus,
- legt auf `windows-latest` das GitHub Release als **Entwurf** an,
- ruft `npm run release:win` auf (electron-builder `--publish always`, Provider `github`, `GITHUB_TOKEN` mit `contents: write`), das Installer, portable EXE und die Update-Metadaten (`latest.yml`) in diesen Entwurf hochlädt,
- veröffentlicht den Entwurf erst danach (`gh release edit <tag> --draft=false`). Schlägt der Build fehl, bleibt nur ein Entwurf zurück, den installierte Versionen nicht sehen; ein erneuter Lauf lädt in denselben Entwurf hoch.

Tags mit Zusatz (`v1.2.3-beta.1`) erscheinen als Vorabversion. Merges auf `main` und Pull Requests bauen die Pakete nur. Die installierte Version findet ein neues Release über die Update-Metadaten und aktualisiert sich nach Bestätigung selbst ([Updates](../reference/funktionen.md#updates)). Sie fragt GitHub nach dem neuesten veröffentlichten Release; fehlt dort `latest.yml`, meldet sie „noch nicht vollständig veröffentlicht“. Deshalb wird ein Release erst veröffentlicht, wenn alle Dateien hochgeladen sind.

## Signieren

Installer *und* portable EXE werden per Authenticode (SHA-256, RFC-3161-Zeitstempel) signiert, sobald ein Zertifikat vorliegt.

- **Lokal**: Umgebungsvariablen `CSC_LINK` (Pfad oder Base64 der `.pfx`) und `CSC_KEY_PASSWORD` setzen.
- **CI**: Repository-Secrets `WIN_CSC_LINK` (Base64-kodierte `.pfx`, z. B. `base64 -w0 zertifikat.pfx`) und `WIN_CSC_KEY_PASSWORD` anlegen. Der Job prüft danach mit `Get-AuthenticodeSignature`, dass alle `.exe`-Dateien gültig signiert sind.

Ohne Zertifikat bleiben die Pakete unsigniert und SmartScreen zeigt eine Warnung – der Normalfall für Pull Requests aus Forks. Ein selbstsigniertes Zertifikat ist nur auf Rechnern vertrauenswürdig, in deren Zertifikatsspeicher es importiert wurde; gegen die SmartScreen-Warnung helfen nur ein Zertifikat einer öffentlichen CA bzw. Azure Trusted Signing.

## Die gepackte App prüfen

`npm run pack -w archivist` baut die App ohne Installer nach `apps/desktop/release/`. Die E2E-Tests laufen nur gegen den ungepackten Build: Die Test-Umgebungsvariablen (`ARCHIVIST_TEST_MODE`, `ARCHIVIST_TEST_PICK_DIR`, `ARCHIVIST_TEST_UPDATE_VERSION` …) wirken in einer gepackten App bewusst nicht. Den Start der gepackten App prüfst du von Hand.
