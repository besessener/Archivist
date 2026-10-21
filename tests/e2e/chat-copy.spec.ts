import { expect, test } from './fixture';

test.describe('chat: copying an answer and showing it as raw text', () => {
  const answer = 'Der Mietvertrag läuft **bis Ende 2026**.\n\n- Kündigung schriftlich\n- Frist: `3 Monate`';

  test.beforeEach(async ({ llm, on, page }) => {
    llm.agentTurns = [{ text: answer }];
    await on(page).setup.do.complete(llm.url);
    await on(page).chat.do.send('Wie lange läuft der Mietvertrag?');
    await expect(on(page).chat.do.lastReply()).toContainText('bis Ende 2026');
  });

  test('„Antwort kopieren“ puts the answer as written on the clipboard', async ({ electronApp, on, page }) => {
    await on(page).chat.do.copyLastReply();

    await expect.poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText())).toBe(answer);
  });

  test('the raw-text switch shows the unformatted answer and switches back', async ({ on, page }) => {
    const chat = on(page).chat;

    await chat.do.toggleRawText();
    await expect(chat.locators.answer.raw).toHaveText(answer);
    await expect(chat.locators.answer.rawToggle).toHaveAttribute('aria-pressed', 'true');

    await chat.do.toggleRawText();
    await expect(chat.locators.answer.raw).toHaveCount(0);
    await expect(chat.do.lastReply().locator('strong')).toHaveText('bis Ende 2026');
  });
});
