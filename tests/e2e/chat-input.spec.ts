import { expect, test } from './fixture';

test.describe('chat: input field and conversation', () => {
  test.beforeEach(async ({ llm, on, page }) => {
    await on(page).setup.do.complete(llm.url);
  });

  test('the input field can be enlarged via the grip, a double click resets it', async ({ on, page }) => {
    const chat = on(page).chat;
    const initial = await chat.do.inputHeight();

    await chat.do.growInput(150);
    expect(await chat.do.inputHeight()).toBeGreaterThan(initial + 100);

    await chat.do.resetInputHeight();
    expect(await chat.do.inputHeight()).toBeLessThan(initial + 10);
  });

  test('a conversation can be renamed', async ({ on, page }) => {
    const chat = on(page).chat;
    // Renaming is only possible once a conversation exists
    await chat.do.send('Hallo');
    await expect(chat.locators.messages.first()).toBeVisible();

    await chat.do.renameConversation('Nordlicht-Entscheidung');
  });
});
