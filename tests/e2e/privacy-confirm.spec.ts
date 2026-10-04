import { expect, test } from './fixture';

test.describe('Privacy mode "ask first" (confirm)', () => {
  test.beforeEach(async ({ llm, on, page }) => {
    await on(page).setup.do.complete(llm.url, 'confirm');
  });

  test('reprocessing from the inbox asks before any content goes to the AI', async ({ llm, on, page, workspace }) => {
    const app = on(page);
    const classifications = () => llm.calls.filter((c) => c.schema === 'DocumentClassification').length;
    const note = workspace.addDownload('jour-fixe.txt', 'Jour Fixe Nordlicht am 04.05.2026.\nTeilnehmer: Anna, Ben.\nDas Projekt Nordlicht wird fortgeführt.');

    await app.inbox.do.importFile(note);
    await app.navigation.do.open('inbox');
    await expect(app.inbox.locators.proposals.first()).toBeVisible({ timeout: 30_000 });
    expect(classifications(), 'an import in mode "ask first" is analysed locally').toBe(0);

    await app.inbox.do.reprocessConfirmed({ allowLlm: false });
    await expect(app.inbox.locators.proposals.first()).toBeVisible({ timeout: 30_000 });

    await app.inbox.do.reprocessConfirmed({ allowLlm: true });
    await expect(app.inbox.locators.llmStatus.first()).toContainText(/KI analysiert/i, { timeout: 30_000 });
    expect(classifications(), 'only the confirmed reprocessing reaches the AI').toBe(1);
  });
});
