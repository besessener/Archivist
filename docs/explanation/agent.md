# Archivist als Agent

> ARCHIVIST SPEICHERT WISSEN NICHT NUR. ARCHIVIST FINDET VERSTREUTES WISSEN, VERSTEHT SEINEN KONTEXT UND HÄLT DAS ARCHIV AKTIV KONSISTENT.

Ein klassisches Archiv wartet darauf, dass du suchst. Archivist soll mehr tun: ein Anliegen verstehen, sich die nötigen Daten selbst beschaffen, mehrere Schritte planen und Änderungen ausführen – im Chat und im Hintergrund (Epic #294). Die technischen Details stehen in der [Referenz zum Agentenmodus](../reference/agentenmodus.md).

## Werkzeuge statt Sonderfälle

Früher erkannte der Chat eine feste Liste von Absichten („Entscheidung speichern“, „Dokument suchen“ …) und führte für jede einen festen Ablauf aus. Das stößt an Grenzen, sobald ein Anliegen mehrere Schritte braucht: „Wie viel habe ich 2025 für Handwerker ausgegeben?“ heißt suchen, Rechnungen lesen, Beträge zusammenzählen.

Im Agentenmodus bekommt das Modell stattdessen **Werkzeuge** – dieselben Service-Funktionen, die auch die Oberfläche nutzt – und entscheidet selbst, welche es in welcher Reihenfolge aufruft. Jedes Werkzeug hat ein Zod-Schema und eine Risikostufe (`read`/`write`/`critical`). Was die Oberfläche nicht darf, darf der Agent auch nicht.

Die regelbasierte Auswertung bleibt als Rückfallebene: ohne LLM, im Modus „nur lokal“ oder bei einem Endpunkt ohne natives Tool-Calling.

## Handeln, aber nachvollziehbar

Ein Agent, der jede Kleinigkeit bestätigen lässt, ist lästig; einer, der unkontrolliert handelt, gefährlich. Archivist löst das über zwei Ebenen:

- **Rückgängig statt Rückfrage**: Im Modus „Auto“ führt der Agent Änderungen selbst aus. Jede trägt die Lauf-ID; ein ganzer Lauf oder ein einzelner Schritt lässt sich mit Konfliktprüfung zurücknehmen. Wer lieber vorher gefragt wird, schaltet auf „Fragen“.
- **Feste Ausnahmen**: Löschen (in den Papierkorb), Originaldateien außerhalb des Archivs, Datenschutz-Einstellungen, neue Hauptkategorien und Massenaktionen werden immer nachgefragt – in jedem Modus, egal was der Agent gelernt hat.

## Grenzen statt Schrittzahl

Eine feste Höchstzahl an Schritten bricht entweder einfache Aufgaben unnötig ab oder lässt komplexe nicht zu Ende laufen. Stattdessen begrenzen Token-Budget, eine Notbremse für Runden, ein Zeitlimit, Schleifenerkennung und dein „Stopp“ den Lauf. Erreicht der Agent eine Grenze, fasst er zusammen, was erledigt ist und was fehlt – du stehst nie vor einem halbfertigen Zustand ohne Erklärung.

Kosten werden geschätzt und angezeigt, aber nicht gedeckelt: Eine Obergrenze würde Läufe mitten in einer Änderung abbrechen.

## Lernen heißt Speichern, nicht Trainieren

Archivist merkt sich Regeln („Rechnungen der Stadtwerke immer nach finanzen/energie“), eigene Abläufe, Korrekturen und Vorlieben – aber als sichtbare, löschbare Einträge, die jedem Lauf mitgegeben werden, nicht als undurchsichtiges Training. Gespeichert wird nur auf deinen Wunsch oder nach Rückfrage und **nie aus Dokumenten**, damit ein Dokument dem Agenten keine dauerhaften Regeln unterschieben kann. Gelerntes hebt nie Modus, Ausnahmen, Datenschutz oder Grenzen auf.

## Anbieterneutral

Der Agent läuft mit Claude (Anthropic Messages API) und mit OpenAI-Modellen (Responses API). Der Verlauf wird anbieterneutral gespeichert, sodass ein Wechsel keinen Neustart und keinen Verlust des Gesprächs bedeutet. Welche Kombination aus Modell und Effort gut funktioniert, lässt sich mit der [Evaluation](../how-to/agent-evaluieren.md) an realistischen Aufgaben messen.

## Websuche

Manche Fragen brauchen Wissen von außen („Welche Kündigungsfrist gilt gesetzlich?“). Der Agent nutzt dafür die eingebaute Websuche des Anbieters, statt selbst Verbindungen aufzubauen. Webseiten sind wie Dokumente nur Daten: Nach einer Websuche ändert ein Lauf nichts, worum du nicht selbst gebeten hast, und Hintergrundaufgaben suchen nie im Web.
