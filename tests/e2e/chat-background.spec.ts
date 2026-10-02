import { expect, test } from './fixture';

test.describe('chat: request in the background', () => {
  test.beforeEach(async ({ llm, on, page }) => {
    await on(page).setup.do.complete(llm.url);
  });

  test('a running request continues when switching tabs and the response appears after returning without reloading', async ({ llm, on, page }) => {
    const app = on(page);
    // Slow AI: the response only arrives after the user has switched tabs
    llm.delayMs = 4_000;

    await app.chat.do.send('Was gibt es Neues zu Nordlicht?');
    await expect(app.chat.locators.thinking).toBeVisible();

    await app.navigation.do.open('decisions');
    await expect(app.chat()).toBeHidden();
    await app.navigation.do.open('chat');

    // The request is still running: the user's own message and „Archivist denkt nach …“ are still visible
    await expect(app.chat.locators.thinking).toBeVisible();
    await expect(app.chat.locators.messages.first()).toContainText('Was gibt es Neues zu Nordlicht?');

    // Afterwards the response appears in the same (new) conversation
    await expect(app.chat.locators.thinking).toBeHidden();
    await expect(app.chat.locators.messages).toHaveCount(2);
    await expect(app.chat.locators.messages.first()).toContainText('Was gibt es Neues zu Nordlicht?');
    await expect(app.chat.locators.conversationSelect).not.toHaveValue('');
  });
});
