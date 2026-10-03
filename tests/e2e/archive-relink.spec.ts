import fs from 'node:fs';
import path from 'node:path';
import { expectNoSeriousA11yViolations } from './axe';
import { expect, test } from './fixture';

test.describe('archive check', () => {
  test.beforeEach(async ({ llm, on, page }) => {
    await on(page).setup.do.complete(llm.url);
  });

  test('a file renamed outside Archivist is found and re-attached after confirmation', async ({ on, page, workspace }, testInfo) => {
    const app = on(page);
    const note = workspace.addDownload('jour-fixe.txt', 'Jour Fixe Nordlicht am 04.05.2026.\nTeilnehmer: Anna, Ben.\nDas Projekt Nordlicht wird fortgeführt.');
    const archivedFile = path.join(workspace.dataDir, 'archive', 'work', 'projects', 'Nordlicht', 'jour-fixe.txt');
    const renamedFile = path.join(path.dirname(archivedFile), 'Protokoll Jour Fixe.txt');
    await app.inbox.do.importFile(note);
    await app.navigation.do.open('inbox');
    await app.inbox.do.waitForProposal('work/projects/Nordlicht');
    await app.inbox.do.openArchivePlan();
    await app.inbox.do.confirmArchive();
    await app.inbox.locators.archivePlan.close.click();
    fs.renameSync(archivedFile, renamedFile);

    await app.navigation.do.open('settings');
    await app.settings.do.openArchive();
    await app.settings.locators.archiveCheck.verify.click();
    await expect(app.settings.locators.archiveCheck.report).toContainText('Es gibt Abweichungen');
    await expectNoSeriousA11yViolations(page, testInfo);

    await app.settings.locators.archiveCheck.relink.click();
    await app.settings.locators.archiveCheck.confirmRelink.click();

    await expect(app.settings.locators.archiveCheck.relinkResult).toContainText('1 Datei(en) neu verknüpft');
    await expect(app.settings.locators.archiveCheck.report).toContainText('Alles in Ordnung');
    expect(fs.readFileSync(renamedFile, 'utf8')).toContain('Jour Fixe');
  });
});
