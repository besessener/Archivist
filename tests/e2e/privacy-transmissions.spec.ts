import { expectNoSeriousA11yViolations } from './axe';
import { expect, test } from './fixture';

test.describe('transmission log', () => {
  test('names the document of an entry and previews the file name and text start instead of the prompt frame', async ({
    llm,
    on,
    page,
    workspace,
  }, testInfo) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    const note = workspace.addDownload('jour-fixe.txt', 'Jour Fixe Nordlicht am 04.05.2026.\nTeilnehmer: Anna, Ben.');
    await app.inbox.do.importFile(note);
    await app.navigation.do.open('inbox');
    await app.inbox.do.waitForProposal('work/projects/Nordlicht');

    await app.navigation.do.open('settings');
    await app.settings.do.openPrivacy();

    const row = app.settings.locators.privacy.transmissions.rows.first();
    await expect(row).toContainText('Dokumentklassifikation');
    await expect(row).toContainText('jour-fixe');
    await app.settings.do.openTransmissionPreview(0);
    await expect(app.settings.locators.privacy.transmissions.preview).toContainText('Datei: jour-fixe.txt | Textanfang: Jour Fixe Nordlicht');
    await expect(app.settings.locators.privacy.transmissions.preview).not.toContainText('Antworte als JSON');
    await expect(app.settings.locators.privacy.transmissions.retentionNote).toBeVisible();
    await expectNoSeriousA11yViolations(page, testInfo);
  });
});
