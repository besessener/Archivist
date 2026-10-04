import fs from 'node:fs';
import path from 'node:path';
import { expectNoSeriousA11yViolations } from './axe';
import { expect, test } from './fixture';

test.describe('trash', () => {
  test.beforeEach(async ({ llm, on, page }) => {
    await on(page).setup.do.complete(llm.url);
  });

  test('a deleted document lands in the trash and can be restored; emptying deletes it for good', async ({ on, page, workspace }, testInfo) => {
    const app = on(page);
    const note = workspace.addDownload('jour-fixe.txt', 'Jour Fixe Nordlicht am 04.05.2026.\nTeilnehmer: Anna, Ben.\nDas Projekt Nordlicht wird fortgeführt.');
    const archivedFile = path.join(workspace.dataDir, 'archive', 'Arbeit', 'Projekte', 'Nordlicht', 'jour-fixe.txt');
    await app.inbox.do.importFile(note);
    await app.navigation.do.open('inbox');
    await app.inbox.do.waitForProposal('Arbeit/Projekte/Nordlicht');
    await app.inbox.do.openArchivePlan();
    await app.inbox.do.confirmArchive();
    await app.inbox.locators.archivePlan.close.click();

    await app.navigation.do.open('documents');
    await expect(app.documents.locators.rows).toHaveCount(1);
    await app.documents.do.moveToTrash(0);
    await expect(app.documents.locators.rows).toHaveCount(0);
    expect(fs.existsSync(archivedFile)).toBe(false);
    expect(fs.existsSync(note), "the user's original stays").toBe(true);

    await app.navigation.do.open('settings');
    await app.settings.do.openArchive();
    await expect(app.settings.locators.trash.items).toHaveCount(1);
    await expectNoSeriousA11yViolations(page, testInfo);
    await app.settings.locators.trash.restore.click();
    await expect(app.settings.locators.trash.items).toHaveCount(0);
    expect(fs.readFileSync(archivedFile, 'utf8')).toContain('Jour Fixe');

    await app.navigation.do.open('documents');
    await expect(app.documents.locators.rows).toHaveCount(1);
    await app.documents.do.moveToTrash(0);
    await app.navigation.do.open('settings');
    await app.settings.do.openArchive();
    await app.settings.do.emptyTrash();
    expect(fs.readdirSync(path.join(workspace.dataDir, 'trash'))).toEqual([]);
    expect(fs.existsSync(note), "the user's original stays").toBe(true);
  });
});
