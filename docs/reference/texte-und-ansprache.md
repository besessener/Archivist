# Texte und Ansprache

## Ansprache

Wir duzen – in der Oberfläche, im Chat, in Benachrichtigungen, Fehlermeldungen und der Dokumentation. Die LLM-Prompts weisen das Modell entsprechend an, den Benutzer mit „du“ anzusprechen.

## Sprache

| Englisch | Deutsch |
| --- | --- |
| alles, was programmiert ist: Bezeichner, Code-Kommentare, Testnamen, Log-Meldungen, Build- und CI-Ausgaben | alles, was Benutzer sehen: Oberfläche, Fehlermeldungen, Benachrichtigungen, Hinweise, Chat-Antworten |
| | außerdem: LLM-Prompts (sie erzeugen deutsche Antworten), Muster für deutsche Eingaben, Testdaten |

Die Oberfläche ist ausschließlich Deutsch – auch Datums- und Zeitfelder (`tt.mm.jjjj`, 24 Stunden), unabhängig von der Sprache des Betriebssystems.

## Dokumentation

Die Dokumentation unter `docs/` folgt [Diátaxis](https://diataxis.fr/):

- **Tutorials** (`docs/tutorials/`) führen Schritt für Schritt zu einem ersten Erfolg – lernorientiert, ohne Abzweigungen.
- **Anleitungen** (`docs/how-to/`) lösen ein konkretes Problem – zielorientiert, setzen Grundwissen voraus.
- **Referenz** (`docs/reference/`) beschreibt genau, was ist – vollständig, nachschlagbar, ohne Begründungen.
- **Hintergrund** (`docs/explanation/`) erklärt, warum es so ist – Entwurfsentscheidungen und Grenzen.

Ändert sich Verhalten, gehört die Änderung in die Referenz; neue Abläufe bekommen eine Anleitung. Die Wurzel-`README.md` bleibt kurz und verweist hierher.

Markdown wird von Hand gepflegt und ist von Prettier ausgenommen.
