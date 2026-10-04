import { expectNoSeriousA11yViolations } from './axe';
import { expect, test } from './fixture';

test.describe('re-processing archived documents (#220)', () => {
  test.beforeEach(async ({ llm, on, page, workspace }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    const note = workspace.addDownload('jour-fixe.txt', 'Jour Fixe Nordlicht am 04.05.2026.\nTeilnehmer: Anna, Ben.\nDas Projekt Nordlicht wird fortgeführt.');
    await app.inbox.do.importFile(note);
    await app.navigation.do.open('inbox');
    await app.inbox.do.waitForProposal('Arbeit/Projekte/Nordlicht');
    await app.inbox.do.openArchivePlan();
    await app.inbox.do.confirmArchive();
    await app.inbox.locators.archivePlan.close.click();
    // the archived metadata came from the AI; from now on every AI transfer needs the consent
    await app.navigation.do.open('settings');
    await app.settings.do.openPrivacy();
    await app.settings.do.selectMode('confirm');
    await app.navigation.do.open('documents');
    await expect(app.documents.locators.rows).toHaveCount(1);
  });

  test('proposes new metadata for an archived document and applies it only after the confirmation', async ({ on, page }, testInfo) => {
    const { documents } = on(page);
    await documents.do.open(0);
    await documents.locators.dialog.edit.click();
    await documents.locators.dialog.editTitle.fill('Eigener Titel');
    await page.getByTestId('doc-save').click();
    await documents.locators.dialog.confirmSave.click();
    await expect(documents.locators.dialog.root).toContainText('Eigener Titel');

    await documents.locators.dialog.reprocess.click();
    await expect(documents.locators.reprocessDialog.estimate).toContainText('1 von 1 Dokument');
    await expectNoSeriousA11yViolations(page, testInfo);
    await documents.locators.reprocessDialog.allowLlm.check();
    await documents.locators.reprocessDialog.start.click();

    await expect(documents.locators.dialog.reanalysis.proposal).toBeVisible({ timeout: 30_000 });
    await expect(documents.locators.dialog.reanalysis.changes.filter({ hasText: 'Titel' })).toContainText('Jour Fixe Nordlicht');
    await expectNoSeriousA11yViolations(page, testInfo);
    await documents.locators.dialog.reanalysis.apply.click();
    await documents.locators.dialog.reanalysis.confirmApply.click();

    await expect(documents.locators.dialog.reanalysis.proposal).toBeHidden();
    await expect(documents.locators.dialog.root).toContainText('Jour Fixe Nordlicht');
  });

  test('marks documents with a pending proposal in the list and lets the user discard it', async ({ on, page }) => {
    const { documents } = on(page);

    await documents.locators.bulk.selectAll.click();
    await documents.locators.bulk.reprocess.click();
    await documents.locators.reprocessDialog.allowLlm.check();
    await documents.locators.reprocessDialog.start.click();

    await expect(documents.locators.proposalBadge).toBeVisible({ timeout: 30_000 });
    await documents.do.open(0);
    await expect(documents.locators.dialog.reanalysis.proposal).toBeVisible();
    await documents.locators.dialog.reanalysis.discard.click();
    await expect(documents.locators.dialog.reanalysis.proposal).toBeHidden();
  });

  test('shows the search index and offers to complete or re-embed it', async ({ on, page }, testInfo) => {
    const { navigation, settings } = on(page);
    await navigation.do.open('settings');
    await settings.do.openArchive();

    await expect(settings.locators.index.status).toContainText('Alle 1 archivierten Dokumente sind im Suchindex');
    await expect(settings.locators.index.rebuild).toBeDisabled();
    await settings.locators.index.reembed.click();
    await expectNoSeriousA11yViolations(page, testInfo);
    await settings.locators.index.confirmReembed.click();
  });
});
