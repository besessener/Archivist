import { expectNoSeriousA11yViolations } from './axe';
import { expect, test } from './fixture';
import { addTransmission, seedTransmissions } from './helpers';

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
    await app.inbox.do.waitForProposal('Arbeit/Projekte/Nordlicht');

    await app.navigation.do.open('settings');
    await app.settings.do.openPrivacy();

    const row = app.settings.locators.privacy.transmissions.rows.first();
    await expect(row).toContainText('Dokumentklassifikation');
    await expect(row).toContainText('Jour Fixe Nordlicht');
    await app.settings.do.openTransmissionPreview(0);
    await expect(app.settings.locators.privacy.transmissions.preview).toContainText('Datei: jour-fixe.txt | Textanfang: Jour Fixe Nordlicht');
    await expect(app.settings.locators.privacy.transmissions.preview).not.toContainText('Antworte als JSON');
    await expect(app.settings.locators.privacy.transmissions.retentionNote).toBeVisible();
    await expectNoSeriousA11yViolations(page, testInfo);
  });
});

/** 150 transmissions from yesterday: more than one page. */
const withTransmissions = test.extend({
  workspace: async ({ workspace }, provide) => {
    seedTransmissions(workspace.dataDir, 150);
    await provide(workspace);
  },
});

withTransmissions.describe('transmission log with more than one page', () => {
  withTransmissions('keeps every entry when new transmissions push older ones onto the next page', async ({ llm, on, page, workspace }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('settings');
    await app.settings.do.openPrivacy();
    const { transmissions } = app.settings.locators.privacy;
    await expect(transmissions.rows).toHaveCount(100);
    await transmissions.more.click();
    await expect(transmissions.rows.filter({ hasText: 'Übertragung tx-0' })).toHaveCount(1);
    await expect(transmissions.more).toBeHidden();
    const shown = await transmissions.rows.count();

    addTransmission(workspace.dataDir, 'tx-new');
    // a settings change writes the change log, which reloads the list
    await app.settings.locators.privacy.maskPersonal.click();

    await expect(transmissions.rows.filter({ hasText: 'Übertragung tx-new' })).toHaveCount(1);
    await expect(transmissions.rows).toHaveCount(shown + 1);
  });
});
