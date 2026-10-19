# Webseite pflegen und veröffentlichen

Die Webseite von Archivist liegt unter `site/` als reines HTML und CSS, ohne Build-Schritt. Sie erscheint auf <https://besessener.github.io/Archivist/>. Aufbau, Abschnitte und Stylesheet teilt sie mit den Seiten von [PlayMonkey](https://besessener.github.io/PlayMonkey/), [flakipype](https://besessener.github.io/flakipype/) und [WOMBOT](https://besessener.github.io/WOMBOT/); nur Texte, Bilder, Icon und die Farbtokens oben in `style.css` unterscheiden sich. Eine Änderung am Aufbau oder am gemeinsamen Teil von `style.css` gehört in alle vier Seiten.

## Einmalig: GitHub Pages einschalten

1. Öffne im Repository Settings → Pages.
2. Wähle unter **Source** den Eintrag **GitHub Actions**.

## Inhalt ändern

1. Bearbeite `site/index.html` oder `site/style.css`; Texte sind Deutsch, sprechen mit „du“ ([Texte und Ansprache](../reference/texte-und-ansprache.md)) und passen zur [README](../../README.md) und zum [Sicherheitsmodell](../explanation/sicherheitsmodell.md). Was die Seite verspricht, muss der Code halten; halte den Stand-Hinweis aktuell.
2. Öffne die Seite lokal, z. B. mit `npx serve site`, und prüfe Hell und Dunkel (Farben des Systems) und ein handybreites Fenster.
3. Führe `npm run format:check` aus; Prettier prüft auch `site/`.

Sobald eine Änderung unter `site/` auf `main` landet, veröffentlicht der Workflow `pages.yml` die Seite. Von Hand startest du ihn unter Actions → Pages → **Run workflow**.

## Screenshots erneuern

Die Bilder in `site/img/` sind Fensteraufnahmen (1280 px breit) der echten App mit dem Fake-LLM der E2E-Tests, je in Hell und Dunkel (`*-light.png`, `*-dark.png`). Nimm sie mit einer kurzen, nicht eingecheckten Playwright-Spec auf, die die Fixtures aus `tests/e2e/fixture.ts` nutzt, und ersetze die Dateien. Zeig keine echten Dokumente oder Namen.
