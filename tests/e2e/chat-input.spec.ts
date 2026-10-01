import { expect, test } from './fixture';

test.describe('Chat: Eingabefeld und Unterhaltung', () => {
  test.beforeEach(async ({ llm, on, page }) => {
    await on(page).setup.do.complete(llm.url);
  });

  test('das Eingabefeld lässt sich über den Griff vergrößern, ein Doppelklick setzt es zurück', async ({ on, page }) => {
    const chat = on(page).chat;
    const initial = await chat.do.inputHeight();

    await chat.do.growInput(150);
    expect(await chat.do.inputHeight()).toBeGreaterThan(initial + 100);

    await chat.do.resetInputHeight();
    expect(await chat.do.inputHeight()).toBeLessThan(initial + 10);
  });

  test('eine Unterhaltung lässt sich umbenennen', async ({ on, page }) => {
    const chat = on(page).chat;
    // Umbenennen ist erst möglich, wenn es eine Unterhaltung gibt
    await chat.do.send('Hallo');
    await expect(chat.locators.messages.first()).toBeVisible();

    await chat.do.renameConversation('Nordlicht-Entscheidung');
  });
});
