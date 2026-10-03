import fs from 'node:fs';
import path from 'node:path';
import { expectNoSeriousA11yViolations } from './axe';
import { expect, test } from './fixture';

test.describe('open document file', () => {
  test.beforeEach(async ({ llm, on, page }) => {
    await on(page).setup.do.complete(llm.url);
  });

  test('a missing archive copy is reported instead of opening a changed original', async ({ on, page, workspace }, testInfo) => {
    const app = on(page);
    const note = workspace.addDownload('jour-fixe.txt', 'Jour Fixe Nordlicht am 04.05.2026.\nTeilnehmer: Anna, Ben.\nDas Projekt Nordlicht wird fortgeführt.');
    const archivedFile = path.join(workspace.dataDir, 'archive', 'work', 'projects', 'Nordlicht', 'jour-fixe.txt');
    await app.inbox.do.importFile(note);
    await app.navigation.do.open('inbox');
    await app.inbox.do.waitForProposal('work/projects/Nordlicht');
    await app.inbox.do.openArchivePlan();
    await app.inbox.do.confirmArchive();
    await app.inbox.locators.archivePlan.close.click();
    fs.renameSync(archivedFile, path.join(path.dirname(archivedFile), 'Protokoll.txt'));
    fs.writeFileSync(note, 'Jour Fixe, neuere Fassung mit anderem Inhalt.');

    await app.navigation.do.open('documents');
    await app.documents.do.openFile(0);

    const toast = app.documents.locators.toasts.filter({ hasText: 'Datei konnte nicht geöffnet werden' });
    await expect(toast).toContainText('Die Archivkopie dieses Dokuments fehlt');
    await expect(toast).toContainText('Verschobene Dateien neu verknüpfen');
    await expectNoSeriousA11yViolations(page, testInfo);
  });
});
