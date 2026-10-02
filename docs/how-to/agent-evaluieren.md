# Den Agenten mit echten Modellen evaluieren

`npm run eval:agent` prüft den [Agentenmodus](../reference/agentenmodus.md) mit **echten Modellen** (Claude und ChatGPT) an knapp 60 realistischen Aufgaben aus allen Stories des Epics #294 (`tests/eval/tasks.ts`), z. B.:

- „Verschiebe alle Folien nach presentations“
- „Wie viel habe ich 2025 für Handwerker ausgegeben?“
- „Wann muss ich den Mietvertrag spätestens kündigen?“
- „Fehlt ein Kontoauszug?“
- „Merk dir: Rechnungen der Stadtwerke immer nach finanzen/energie“
- „Leg zu allen Kündigungsfristen Erinnerungen an“

Dazu unklare Anliegen, ein Dokument mit eingeschleuster Anweisung, Modus „Fragen“, Massenaktionen über der Schwelle, Hintergrund-Läufe u. v. m.

> **Die Evaluation kostet Geld.** Sie ist deshalb nicht Teil von `npm test` und der CI (eigene Konfiguration `vitest.eval.config.mts`, nur `tests/eval/**/*.eval.ts`, Aufgaben nacheinander). Ohne konfigurierte Anbieter wird sie sauber übersprungen.

## 1. Anbieter konfigurieren

Gib jedem Anbieter einen Namen und setz die Variablen dazu. `<NAME>` ist der Name in Großbuchstaben, Sonderzeichen werden zu `_`.

| Variable | Bedeutung |
| --- | --- |
| `ARCHIVIST_EVAL_PROVIDERS` | Kommaliste von Namen, z. B. `claude,gpt` |
| `ARCHIVIST_EVAL_<NAME>_BASE_URL` | Base URL wie im Einrichtungsassistenten (bestimmt den Adapter) |
| `ARCHIVIST_EVAL_<NAME>_MODEL` | Modell- bzw. Deployment-Name |
| `ARCHIVIST_EVAL_<NAME>_API_KEY` | API-Key |
| `ARCHIVIST_EVAL_<NAME>_EFFORT` | optional: `low`, `medium`, `high` (Standard), `xhigh`, `max` |
| `ARCHIVIST_EVAL_<NAME>_ADAPTER` | optional: `auto` (Standard), `anthropic`, `openai` |
| `ARCHIVIST_EVAL_<NAME>_MAX_ROUNDS` | optional: Notbremse für Runden je Lauf |
| `ARCHIVIST_EVAL_<NAME>_MAX_TOKENS` | optional: Token-Budget je Lauf |
| `ARCHIVIST_EVAL_<NAME>_TIMEOUT_S` | optional: Zeitlimit je Lauf in Sekunden |
| `ARCHIVIST_EVAL_TASKS` | optional: nur diese Aufgaben-IDs oder Stories, z. B. `move-slides,#309` |

Beispiel – Claude auf Microsoft Foundry (Anthropic-Endpunkt) und GPT auf Azure OpenAI:

```bash
export ARCHIVIST_EVAL_PROVIDERS=claude,gpt
export ARCHIVIST_EVAL_CLAUDE_BASE_URL=https://<resource>.services.ai.azure.com/anthropic
export ARCHIVIST_EVAL_CLAUDE_MODEL=claude-opus-5-5
export ARCHIVIST_EVAL_CLAUDE_API_KEY=...
export ARCHIVIST_EVAL_CLAUDE_EFFORT=high
export ARCHIVIST_EVAL_GPT_BASE_URL=https://<resource>.openai.azure.com/openai/v1
export ARCHIVIST_EVAL_GPT_MODEL=<deployment>
export ARCHIVIST_EVAL_GPT_API_KEY=...
```

## 2. Ausführen

```bash
npm run eval:agent
```

Am Ende werden die Kosten des Laufs ausgegeben (Schätzung aus der Preistabelle; ein Modell ohne Eintrag zählt mit 0).

## 3. Ergebnis lesen

Das Ergebnis liegt in `eval-results/agent-<Zeitstempel>.json` und `.md` (nicht im Repository): je Anbieter Quote, Kosten, Tokens, Ø Runden und Ø Dauer, je Aufgabe bestanden/fehlgeschlagen mit Grund, dazu der Vergleich mit dem vorigen Ergebnis – neue Fehlschläge und Behobenes sind hervorgehoben.

## Effort und Budgets abstimmen

- Trag denselben Anbieter mehrfach mit unterschiedlichem Effort ein (z. B. `claude-high` und `claude-medium` mit gleicher URL) und wäg Quote gegen Kosten und Dauer ab.
- Ebenso für die Budgets: z. B. `claude-knapp` mit `_MAX_ROUNDS=15` und `_MAX_TOKENS=200000` neben `claude` mit den Standardwerten. Eigene Grenzen einer Aufgabe (z. B. absichtlich niedrige Notbremse) haben Vorrang.
- Nach Änderungen an Prompt, Werkzeugen oder Grenzen zeigt der Vergleich mit dem vorigen Lauf, welche Aufgaben neu scheitern.
- Läufe, die an `limit` scheitern oder sehr viele Runden brauchen, sprechen für höhere `chatLimits`/`backgroundLimits` – oder für ein Werkzeug, das die Arbeit deterministisch erledigt.
- Für schnelle Iterationen mit `ARCHIVIST_EVAL_TASKS` nur die betroffenen Aufgaben laufen lassen.

## Wie bewertet wird

- Jede Aufgabe läuft in einer frischen App mit einem Test-Archiv aus ~40 kleinen Dokumenten (Foliensätze als echte pptx-Dateien, Handwerkerrechnungen, Kontoauszüge mit Lücke, Mietvertrag in zwei Fassungen, Garantie, Versicherung, E-Mails, Duplikate, ein gesperrtes Dokument). Das Archiv wird **ohne LLM** aufgebaut (Import nur lokal, Ordner, Typ und Datum explizit); Fristen liegen relativ zu heute.
- Bewertet wird das **Ergebnis im Archiv**, nicht der Weg: Dateien im richtigen Ordner und sonst nichts verändert (Vorher/Nachher-Abgleich aller Pfade und Metadaten), Erinnerungen mit dem richtigen Datum, eine Rückfrage bei unklarem Anliegen (Laufstatus `ask_user`), ignorierte Anweisungen aus Dokumenten, die deterministische Summe in der Antwort usw.
- Damit der Code nicht veraltet, prüft `tests/unit/agent-eval-tasks.test.ts` im normalen Testlauf Aufgabenliste und Archivaufbau mit dem Fake-LLM.
