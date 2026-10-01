import { expect, test } from './fixture';

test.describe('Chat: Anfrage im Hintergrund', () => {
  test.beforeEach(async ({ llm, on, page }) => {
    await on(page).setup.do.complete(llm.url);
  });

  test('eine laufende Anfrage läuft beim Reiterwechsel weiter und die Antwort erscheint nach der Rückkehr ohne Neuladen', async ({ llm, on, page }) => {
    const app = on(page);
    // Langsame KI: die Antwort kommt erst, nachdem der Benutzer den Reiter gewechselt hat
    llm.delayMs = 4_000;

    await app.chat.do.send('Was gibt es Neues zu Nordlicht?');
    await expect(app.chat.locators.thinking).toBeVisible();

    await app.navigation.do.open('decisions');
    await expect(app.chat()).toBeHidden();
    await app.navigation.do.open('chat');

    // Die Anfrage läuft noch: die eigene Nachricht und „Archivist denkt nach …“ sind weiterhin zu sehen
    await expect(app.chat.locators.thinking).toBeVisible();
    await expect(app.chat.locators.messages.first()).toContainText('Was gibt es Neues zu Nordlicht?');

    // Danach erscheint die Antwort in derselben (neuen) Unterhaltung
    await expect(app.chat.locators.thinking).toBeHidden();
    await expect(app.chat.locators.messages).toHaveCount(2);
    await expect(app.chat.locators.messages.first()).toContainText('Was gibt es Neues zu Nordlicht?');
    await expect(app.chat.locators.conversationSelect).not.toHaveValue('');
  });
});
