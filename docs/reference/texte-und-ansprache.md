# Texte und Ansprache

## Ansprache

Wir duzen – in der Oberfläche, im Chat, in Benachrichtigungen, Fehlermeldungen und der Dokumentation. Die LLM-Prompts weisen das Modell entsprechend an, den Benutzer mit „du“ anzusprechen.

## Sprache

| Englisch | Deutsch |
| --- | --- |
| alles, was programmiert ist: Bezeichner, Code-Kommentare, Testnamen, Log-Meldungen, Build- und CI-Ausgaben | alles, was Benutzer sehen: Oberfläche, Fehlermeldungen, Benachrichtigungen, Hinweise, Chat-Antworten |
| | außerdem: LLM-Prompts (sie erzeugen deutsche Antworten), Muster für deutsche Eingaben, Testdaten |

## Begriffe

- **KI** ist das Wort für das Sprachmodell in allem, was Benutzer sehen („per KI analysiert“, „Die KI ist nicht konfiguriert“). **LLM** bleibt Fachbegriff in Code, Docs und Prompts.
- Interne Werte (Status, Beziehungsarten, Eintragsarten, Audit-Aktionen, Fehlercodes) erscheinen nie roh im Text: Es gibt immer eine deutsche Bezeichnung (`DECISION_STATUS_LABELS`, `RELATION_TYPE_LABELS`, `OPEN_ITEM_STATUS_LABELS` in `packages/shared`, `auditActionLabel` im Renderer). Eine Prüfung stellt sicher, dass jede Audit-Aktion des Kerns eine Bezeichnung hat.
- Die Zuverlässigkeit einer Einschätzung heißt „Sicherheit“, nicht „Confidence“.
- Dateisystemfehler werden in einfachem Deutsch erklärt, der Fehlercode steht nur in den technischen Details. Unbekannte Fehler heißen „Unerwarteter Fehler“, nicht „Ungültige Eingabe“.

Die Oberfläche ist ausschließlich Deutsch – auch Datums- und Zeitfelder (`tt.mm.jjjj`, 24 Stunden), unabhängig von der Sprache des Betriebssystems.

## Dokumentation

Die Dokumentation unter `docs/` folgt [Diátaxis](https://diataxis.fr/):

- **Tutorials** (`docs/tutorials/`) führen Schritt für Schritt zu einem ersten Erfolg – lernorientiert, ohne Abzweigungen.
- **Anleitungen** (`docs/how-to/`) lösen ein konkretes Problem – zielorientiert, setzen Grundwissen voraus.
- **Referenz** (`docs/reference/`) beschreibt genau, was ist – vollständig, nachschlagbar, ohne Begründungen.
- **Hintergrund** (`docs/explanation/`) erklärt, warum es so ist – Entwurfsentscheidungen und Grenzen.

Ändert sich Verhalten, gehört die Änderung in die Referenz; neue Abläufe bekommen eine Anleitung. Die Wurzel-`README.md` bleibt kurz und verweist hierher.

Markdown wird von Hand gepflegt und ist von Prettier ausgenommen.
