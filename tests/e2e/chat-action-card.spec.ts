import { expect, test } from './fixture';

test.describe('chat: proposal card follows the decision (#249)', () => {
  test.beforeEach(async ({ llm, on, page, workspace }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.inbox.do.importFiles(['protokoll-1.txt', 'protokoll-2.txt'].map((name) => workspace.addDownload(name, `Jour Fixe Nordlicht ${name}.`)));
    await app.navigation.do.open('inbox');
    await expect(app.inbox.locators.proposals).toHaveCount(2, { timeout: 60_000 });
    await app.navigation.do.open('chat');
    await app.chat.do.send('Archiviere alle Dokumente aus dem Eingang.');
    await expect(app.chat.locators.actionCards.last()).toHaveAttribute('data-status', 'proposed');
  });

  test('an answer „ja“ in the chat updates the card without a reload', async ({ on, page }) => {
    const app = on(page);

    await app.chat.do.send('ja');

    await expect(app.chat.locators.actionCards.last()).toHaveAttribute('data-status', 'executed', { timeout: 30_000 });
    await expect(app.chat.locators.actionCards.last().getByTestId('action-approve')).toBeHidden();
  });

  test('confirming on the card says the action was executed', async ({ on, page }) => {
    const app = on(page);

    await app.chat.do.approveLastAction();

    await expect(app.chat.locators.toasts.filter({ hasText: 'Aktion ausgeführt.' })).toBeVisible({ timeout: 30_000 });
    await expect(app.chat.locators.actionCards.last()).toHaveAttribute('data-status', 'executed');
  });

  test('confirming in the context panel executes the action and updates the card under the answer', async ({ on, page }) => {
    const app = on(page);

    await app.chat.locators.panelActionCards.last().getByTestId('action-approve').click();

    await expect(app.chat.locators.panelActionCards.last()).toHaveAttribute('data-status', 'executed', { timeout: 30_000 });
    await expect(app.chat.locators.actionCards.last()).toHaveAttribute('data-status', 'executed', { timeout: 30_000 });
  });
});
