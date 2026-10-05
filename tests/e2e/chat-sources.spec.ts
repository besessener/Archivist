import { expect, test } from './fixture';

test.describe('sources in the chat', () => {
  test('a document source leads to the document details and shows the matched passage (#174)', async ({ llm, on, page, workspace }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    const note = workspace.addDownload('jour-fixe.txt', 'Jour Fixe Nordlicht am 04.05.2026.\nTeilnehmer: Anna, Ben.\nDas Projekt Nordlicht wird fortgeführt.');
    await app.inbox.do.importFile(note);
    await app.navigation.do.open('inbox');
    await app.inbox.do.waitForProposal('Arbeit/Projekte/Nordlicht');
    await app.inbox.do.openArchivePlan();
    await app.inbox.do.confirmArchive();
    await app.inbox.locators.archivePlan.close.click();
    await app.navigation.do.open('chat');

    await app.chat.do.send('Wann haben wir Nordlicht pausiert?');

    await expect(app.chat.locators.sources.first()).toBeVisible();
    await expect(app.chat.locators.sourceOpenFile.first()).toBeVisible();
    await app.chat.locators.sources.first().click();
    await expect(app.chat.locators.sourceDialog).toBeVisible();
    await expect(page).toHaveURL(/\/chat/);
  });
});
