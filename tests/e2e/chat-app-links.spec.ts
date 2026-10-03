import { expect, test } from './fixture';

test.describe('chat: links to entries', () => {
  test('an answer links to in-app pages; other paths stay plain text', async ({ llm, on, page }) => {
    llm.agentTurns = [{ text: 'Offen: [Offene Punkte](/open-items/) – nicht verlinkt: [Einstellungen](/settings/)' }];
    await on(page).setup.do.complete(llm.url);
    const app = on(page);

    await app.chat.do.send('Was steht an?');
    await expect(app.chat.do.lastReply()).toContainText('Offene Punkte');
    await expect(app.chat.locators.appLinks).toHaveCount(1);
    await expect(app.chat.do.lastReply()).toContainText('[Einstellungen](/settings/)');

    await app.chat.locators.appLinks.click();
    await expect(page).toHaveURL(/\/open-items\/?$/);
  });
});
