import { expect, test } from './fixture';

test.describe('ignoring a document (#232)', () => {
  test.beforeEach(async ({ llm, on, page, workspace }) => {
    await on(page).setup.do.complete(llm.url);
    await on(page).inbox.do.importFile(workspace.addDownload('werbung.txt', 'Jour Fixe Nordlicht am 04.05.2026.\nDas Projekt Nordlicht wird fortgeführt.'));
    await on(page).navigation.do.open('inbox');
    await on(page).inbox.do.waitForProposal('Arbeit/Projekte/Nordlicht');
  });

  test('„Rückgängig“ in the toast brings the document back with its proposal', async ({ on, page }) => {
    const { inbox } = on(page);

    await inbox.do.ignoreFirst();

    await expect(inbox.locators.items).toHaveCount(0);
    await expect(inbox.locators.ignore.toast.filter({ hasText: 'Dokument ignoriert.' })).toBeVisible();
    await inbox.locators.ignore.toast.getByRole('button', { name: 'Rückgängig' }).click();

    await expect(inbox.locators.items).toHaveCount(1);
    await expect(inbox.locators.items.first()).toHaveAttribute('data-status', 'proposed');
    await expect(inbox.locators.proposals.first()).toContainText('Arbeit/Projekte/Nordlicht');
  });

  test('an ignored document is listed under „Ignoriert“ and „Wieder aufnehmen“ restores its status', async ({ on, page }) => {
    const { inbox } = on(page);
    await inbox.do.ignoreFirst();
    await expect(inbox.locators.items).toHaveCount(0);

    await inbox.locators.ignore.filter.click();
    await expect(inbox.locators.items).toHaveCount(1);
    await expect(inbox.locators.items.first()).toHaveAttribute('data-status', 'ignored');
    await inbox.locators.ignore.takeBack.click();
    await expect(inbox.locators.items).toHaveCount(0);

    await inbox.locators.ignore.allFilter.click();
    await expect(inbox.locators.items).toHaveCount(1);
    await expect(inbox.locators.items.first()).toHaveAttribute('data-status', 'proposed');
  });
});
