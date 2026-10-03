# Architektur

Archivist ist eine lokale Desktop-Anwendung aus Electron, Next.js und TypeScript. Alles ist JavaScript/TypeScript – **kein Python, kein HTTP-Backend, keine Datenbankinstallation, kein Docker**. Alle Daten (Metadaten, Embeddings, Logs, Dateien) liegen lokal; nach außen spricht Archivist nur mit dem von dir konfigurierten LLM-Endpunkt.

```
┌────────────────────────── Electron ───────────────────────────┐
│  Renderer (Next.js, statisch exportiert, sandbox, CSP)        │
│    React · Tailwind · shadcn/ui-Stil                          │
│          │  window.archivist.invoke(channel, input)           │
│  Preload (contextBridge, explizite Kanal-Allowlist)           │
│          │  ipcRenderer.invoke  (nur Kanäle des IPC-Vertrags) │
│  Main-Prozess                                                  │
│    · prüft Absender, validiert Ein-/Ausgabe mit Zod            │
│    · delegiert ausschließlich an den Service-Layer             │
│    · Betriebssystem: Dialoge, safeStorage, Notifications       │
│          │                                                     │
│  @archivist/core  (reines TypeScript, ohne Electron-Abhängigkeit)
│    Services · SQLite (better-sqlite3 + Drizzle) · LLM-Client   │
│          │ Aufgaben (Hash, Scan, Parser, Cosine)               │
│  Worker-Threads (Pool)                                         │
└────────────────────────────────────────────────────────────────┘
```

## Ein Vertrag für alles

`packages/shared/src/ipc.ts` definiert für jeden IPC-Kanal Input- *und* Output-Schema (Zod). Renderer-Typen, Preload-Allowlist, Main-Validierung und Tests leiten sich daraus ab. Es gibt deshalb keine Stelle, an der Renderer und Main-Prozess unterschiedliche Vorstellungen davon haben könnten, was über die Grenze geht. Fehler kommen immer als `Result` mit einer festen [Kategorie](../reference/projektstruktur.md#fehlerkategorien) zurück, nie als geworfene Ausnahme quer durch den IPC.

## Service-Layer ohne Electron

`@archivist/core` kennt weder Electron noch HTTP. Die gesamte Geschäftslogik ist dadurch mit Vitest gegen eine echte SQLite-Datenbank und einen Fake-LLM-Endpunkt testbar, ohne ein Fenster zu öffnen. Was wirklich vom Betriebssystem kommt (safeStorage, Dialoge, `shell`), wird über kleine Schnittstellen (`SecretCipher`, `HostApi`) injiziert. dependency-cruiser erzwingt die Grenzen: Der Renderer kennt nur `shared`, der Core weder Electron noch UI.

Services, die sich gegenseitig brauchen (`actions` mit `archive`, `contradictions`, `insights`; `chat` und `capture` mit `actions`), bekommen ihre Partner nach der Konstruktion über `wire()` (`composition/wiring.ts`). Die Importe dazwischen sind `import type`, daher sieht die Regel `no-circular` sie nicht. Eine zweite Regel (`no-type-only-service-cycles`, Warnung) schließt diese Typ-Zyklen ein, und eine Baseline verhindert, dass neue hinzukommen; Details in [qualitaetssicherung.md](../reference/qualitaetssicherung.md). Aktuell gibt es keinen Typ-Zyklus: `actions` kennt die Gegenseiten nur über schmale Schnittstellen.

## Main-Prozess bleibt frei

Ein blockierter Main-Prozess friert in Electron das ganze Fenster ein. Deshalb:

- Datenbankzugriffe sind kurz (synchrones better-sqlite3).
- Lange Lesezugriffe (Timeline, Dokumentliste, Zähler) laufen in einem eigenen Lese-Worker mit eigener schreibgeschützter Verbindung (WAL).
- Hashing, Verzeichnisscans, Textextraktion und Vektorsuche laufen im Worker-Pool.
- Die Archivprüfung gibt den Main-Thread zwischen ihren Schritten und in langen Schleifen frei.
- Langlaufende Abläufe sind Jobs in der persistenten [Job-Queue](../reference/funktionen.md#job-queue).

## Kritisches nur mit Bestätigung

Der Agent erzeugt *Vorschläge* (`agent_actions`) mit Begründung, Confidence und betroffenen Objekten. Ausführen kann sie nur `actions:resolve` mit `confirmed: true` – auf IPC-Ebene als `z.literal(true)` erzwungen. Damit hängt die Sicherheit nicht davon ab, dass die Oberfläche alles richtig macht: Ein Aufruf ohne Bestätigung scheitert schon an der Schema-Validierung.

Ein „ja“ im Chat bestätigt nur Vorschläge, die **in diesem Gespräch** als Karte angezeigt werden und noch offen sind; sind es mehrere, fragt Archivist nach. Vorschläge der Archivprüfung lassen sich nur über Insights bzw. Benachrichtigungen ausführen. Welche Aktion welche Bestätigung braucht: [Aktionsstufen](../reference/aktionsstufen.md).

## Weiterlesen

- [Projektstruktur und Services](../reference/projektstruktur.md)
- [Sicherheits- und Datenschutzmodell](sicherheitsmodell.md)
- [Archivist als Agent](agent.md)
