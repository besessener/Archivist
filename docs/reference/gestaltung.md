# Gestaltung der Oberfläche

Farben, Flächen und Hervorhebungen des Renderers. Alle Werte sind Tokens in `apps/renderer/app/globals.css`, je für hell und dunkel; Komponenten verwenden nur die Tokens, nie feste Farbwerte.

## Farbschema

Einstellungen → Darstellung: **Wie das System** (Standard), **Hell** oder **Dunkel** (`appearance.theme`). Der Hauptprozess setzt `nativeTheme.themeSource`; `prefers-color-scheme` im Renderer folgt sofort, ohne Neustart.

## Flächen

Drei Ebenen, von hinten nach vorn:

| Ebene | Token | Verwendung |
| --- | --- | --- |
| Seitenleiste | `--sidebar` | Navigation, Kontextspalte im Chat |
| Arbeitsfläche | `--canvas` | Hintergrund jeder Seite (`body`), Eingabeleiste im Chat, Vollbild des Graphen |
| Karte | `--card` mit `shadow-card` | jede Karte und jeder Listeneintrag, der für sich steht |

`--background` bleibt die Farbe von Eingabefeldern, Checkboxen und Outline-Buttons.

## Farben nach Art

Jede Art eines Eintrags hat eine Farbe (`ENTITY_TYPE_TONES` in `apps/renderer/lib/nav.ts`):

| Farbe | Token | Arten |
| --- | --- | --- |
| Blau | `--type-document` | Dokument |
| Gold | `--type-decision` | Entscheidung |
| Grün | `--type-person` | Person |
| Violett | `--type-project` | Projekt, Vorgang |
| Petrol | `--type-topic` | Thema, Kategorie, Schlagwort |
| Pink | `--type-task` | Aufgabe, Frage, Erinnerung |
| Rot | `--destructive` | Widerspruch |
| Grau | `--muted-foreground` | Ereignis, Notiz |

Ein Element setzt `data-tone="<Farbe>"`; darin stehen die Klassen `text-tone`, `bg-tone/…` und `border-tone/…` für diese Farbe. Die Farbe steht am Symbol und als leichte Tönung von Chips (`EntityChip`, `TypeBadge`), an Knoten im Wissensgraphen und an den Markierungen der Timeline. Text bleibt in der Vordergrundfarbe.

## Bereiche

Die Bereiche der Navigation stehen in `apps/renderer/lib/sections.ts`. Jede Seitenüberschrift (`PageHeader`) zeigt das Symbol ihres Bereichs in einer Kachel, getönt in der Farbe dessen, was der Bereich auflistet (Dokumente blau, Entscheidungen gold, offene Punkte pink, Wissen petrol). Chat und Insights sind indigo, Timeline, Scan und Einstellungen grau. Der aktive Eintrag der Navigation ist eine Karte mit indigo Balken am linken Rand.

## Warnfarbe

Warnungen sind in beiden Schemata gelb, deutlich getrennt von Rot: Text `--warning` auf `--warning-surface` (Badges, Hinweiskästen), Streifen `--attention`.

## Indigo

Indigo (`--primary`) steht für Aktionen und Auswahl: Hauptbuttons, Links, Fokusrahmen, aktive Filter, der aktive Navigationseintrag. Hinweise in Blau (`--info`): Badges „Erinnerung …“ und Hinweiskästen.

## Zähler in der Navigation

| Darstellung | Wann |
| --- | --- |
| grau | offene Einträge (Inbox, offene Punkte, Hinweise) |
| rot | Inbox: mindestens ein Dokument fehlgeschlagen oder in Quarantäne; offene Punkte: mindestens einer überfällig (`overdueOpenItems` im App-Status) |
| umrandet grau | offene Verknüpfungsvorschläge (nach den Hinweisen) |

## Statusstreifen

Ein Streifen am linken Rand einer Karte (`data-stripe`) zeigt ihren Zustand, bevor man ein Badge liest:

| Streifen | Karten |
| --- | --- |
| rot (`danger`) | offener Punkt überfällig; Entscheidung widerrufen; Widerspruch; Inbox-Dokument fehlgeschlagen oder in Quarantäne |
| gelb (`warning`) | offener Punkt in den nächsten 7 Tagen fällig; Entscheidung im Entwurf; Hinweis auf abgelaufene, veraltete oder vermutlich ersetzte Angaben |

## Aktionen auf Karten

Offene Punkte und Inbox-Dokumente zeigen ihre Hauptaktion mit Beschriftung („Erledigt …“, „Archivieren …“). Seltenere Aktionen sind Symbolbuttons (`IconAction`); ihre Beschriftung ist zugänglicher Name und Tooltip.

## Überschriften

Seitentitel: `text-2xl`. Gruppen von Karten („Überfällig“, Arten von Hinweisen, „Widersprüche“) tragen eine kleine Überschrift in Großbuchstaben (`GROUP_HEADING`); „Überfällig“ ist rot.

## Kontrast

Text erfüllt WCAG 2.2 AA (4,5:1) auf Karte und Arbeitsfläche, in beiden Farbschemata; `accessibility.spec.ts` prüft das helle Schema mit axe. Farbe ist nie das einzige Signal: Streifen und Zähler stehen neben Badge, Gruppe oder zugänglichem Namen.
