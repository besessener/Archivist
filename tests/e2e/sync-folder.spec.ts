import path from 'node:path';
import { expectNoSeriousA11yViolations } from './axe';
import { expect, test } from './fixture';

test.describe('archive inside a cloud-synced folder (#207)', () => {
  test.describe('when the data directory lies in OneDrive', () => {
    test.use({ dataParent: 'OneDrive' });

    test('warns in the setup and in the settings', async ({ llm, on, page }, testInfo) => {
      const app = on(page);
      await expect(app.setup.locators.texts.syncWarning).toContainText('OneDrive');
      await expect(app.setup.locators.texts.syncWarning).toContainText('Datenordner');
      // with ARCHIVIST_DATA_DIR the data folder holds the application state too
      await expect(app.setup.locators.texts.syncWarning).toContainText(
        'Im Datenordner liegen Eingang, Quarantäne, Papierkorb, Datenbank, Einstellungen und Backups.',
      );
      await expectNoSeriousA11yViolations(page, testInfo);

      await app.setup.do.complete(llm.url);
      await app.navigation.do.open('settings');
      await app.settings.do.openArchive();

      await expect(app.settings.locators.archiveRoot.syncNotice).toContainText('OneDrive');
      await expect(app.settings.locators.archiveRoot.syncNotice).toContainText('Datenordner');
      await expectNoSeriousA11yViolations(page, testInfo);
    });
  });

  test('says nothing for an ordinary folder and warns before the archive is moved into a synced one', async ({ llm, on, page, workspace }, testInfo) => {
    const app = on(page);
    await expect(app.setup.locators.texts.syncWarning).toBeHidden();
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('settings');
    await app.settings.do.openArchive();
    await expect(app.settings.locators.archiveRoot.syncNotice).toBeHidden();

    const { archiveRoot } = app.settings.locators;
    await app.settings.do.startArchiveRootChange(path.join(path.dirname(workspace.dataDir), 'Dropbox', 'Archiv'));
    await expect(archiveRoot.dialog.syncNotice).toContainText('Dropbox');
    await expectNoSeriousA11yViolations(page, testInfo);
    await archiveRoot.dialog.cancel.click();

    await app.settings.do.startArchiveRootChange(path.join(path.dirname(workspace.dataDir), 'NAS', 'Archiv'));
    await expect(archiveRoot.dialog.syncNotice).toBeHidden();
  });
});
