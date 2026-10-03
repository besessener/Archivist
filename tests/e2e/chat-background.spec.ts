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

  test('the card of a big archiving shows the result once its job has run, even after the answer came without it (#254)', async ({
    llm,
    on,
    page,
    workspace,
  }) => {
    const app = on(page);
    const protocols = Array.from({ length: 10 }, (_, i) => workspace.addDownload(`protokoll-${i}.txt`, `Jour Fixe Nordlicht Nummer ${i}.`));
    await app.inbox.do.importFiles(protocols);
    await app.navigation.do.open('inbox');
    await expect(app.inbox.locators.proposals).toHaveCount(10, { timeout: 60_000 });
    await app.navigation.do.open('chat');
    await app.chat.do.send('Archiviere alle Dokumente aus dem Eingang.');
    await expect(app.chat.locators.actionCards.last()).toHaveAttribute('data-status', 'proposed');

    // two slow analyses occupy the job queue, so the archiving job only starts after the confirmation stopped waiting for it
    llm.delayMs = 25_000;
    // one file at a time: each gets its own analysis job (several files at once share one batch job)
    await app.inbox.do.importFiles([workspace.addDownload('nachtrag-1.txt', 'Nachtrag eins.')]);
    await app.inbox.do.importFiles([workspace.addDownload('nachtrag-2.txt', 'Nachtrag zwei.')]);
    await app.chat.do.approveLastAction();

    await expect(app.chat.locators.actionCards.last()).toHaveAttribute('data-status', 'approved', { timeout: 30_000 });
    await expect(app.chat.locators.actionCards.last()).toContainText('Wird ausgeführt');
    await expect(app.chat.locators.actionCards.last()).toHaveAttribute('data-status', 'executed', { timeout: 60_000 });
    await expect(app.chat.locators.actionCards.last()).toContainText(/10 archiviert/);
  });
});
