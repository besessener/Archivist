# Entwicklungsumgebung aufsetzen

In diesem Tutorial klonst du Archivist, startest die App mit Hot Reload und lässt die Tests laufen.

**Du brauchst** Node.js ≥ 22 und npm ≥ 10. Entwickelt und gepflegt wird für **Windows**; `npm run dev` funktioniert in der Regel auch unter Linux und macOS, wird dort aber nicht zugesichert.

## 1. Klonen und installieren

```bash
git clone https://github.com/besessener/Archivist.git
cd Archivist
npm install            # installiert alle Workspaces (inkl. Electron)
```

## 2. Prüfen, ob die nativen Module laufen

```bash
npm run native:check
```

Der Befehl lädt `better-sqlite3` und `sharp` in Node **und** in der Electron-Laufzeit. Er muss in beiden Fällen erfolgreich sein.

## 3. App starten

```bash
npm run dev            # Next.js-Dev-Server + Electron mit Hot Reload
```

Es öffnet sich das Archivist-Fenster mit dem Einrichtungsdialog. Ändere eine Komponente unter `apps/renderer/components/` – die Änderung erscheint sofort.

Die Dokumente landen unter `~/Documents/Archivist/`, Datenbank, Einstellungen und Backups im Datenordner deines Benutzerprofils (Electron-`userData`). Um dein echtes Archiv nicht anzufassen, setz vorher ein eigenes Datenverzeichnis; damit liegt alles unter diesem einen Ordner:

```bash
ARCHIVIST_DATA_DIR=~/archivist-dev npm run dev
```

## 4. Tests laufen lassen

```bash
npm run typecheck
npm run lint
npm test
```

Alle drei müssen grün sein. Zum Schluss die End-to-End-Tests gegen die echte Electron-App:

```bash
npm run test:e2e       # unter Linux ohne Bildschirm: xvfb-run -a npm run test:e2e
```

## Geschafft

Du hast eine laufende Entwicklungsumgebung. Als Nächstes:

- [Architektur](../explanation/architektur.md) – wie Renderer, Main-Prozess und Core zusammenspielen,
- [Projektstruktur und Services](../reference/projektstruktur.md),
- [npm-Befehle](../reference/befehle.md) und [Tests und Qualitätssicherung](../reference/qualitaetssicherung.md),
- [Texte und Ansprache](../reference/texte-und-ansprache.md) – Konventionen für Code und Oberfläche.
