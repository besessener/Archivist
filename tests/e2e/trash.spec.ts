import fs from 'node:fs';
import path from 'node:path';
import { expectNoSeriousA11yViolations } from './axe';
import { expect, test, type Workspace } from './fixture';
import { holdDatabaseReader } from './helpers';
import type { PageTree } from './pages';

const NOTE = 'Jour Fixe Nordlicht am 04.05.2026.\nTeilnehmer: Anna, Ben.\nDas Projekt Nordlicht wird fortgeführt.';

/** Imports and archives the Jour-Fixe note, then moves it into the trash; returns the path of the user's original. */
async function trashArchivedNote(app: PageTree, workspace: Workspace): Promise<string> {
  const note = workspace.addDownload('jour-fixe.txt', NOTE);
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
  return note;
}

test.describe('trash', () => {
  test.beforeEach(async ({ llm, on, page }) => {
    await on(page).setup.do.complete(llm.url);
  });

  test('documents selected in the list go into the trash without opening them', async ({ on, page, workspace }) => {
    const app = on(page);
    const note = workspace.addDownload('jour-fixe.txt', NOTE);
    await app.inbox.do.importFile(note);
    await app.navigation.do.open('inbox');
    await app.inbox.do.waitForProposal('Arbeit/Projekte/Nordlicht');
    await app.inbox.do.openArchivePlan();
    await app.inbox.do.confirmArchive();
    await app.inbox.locators.archivePlan.close.click();
    await app.navigation.do.open('documents');
    await expect(app.documents.locators.rows).toHaveCount(1);

    await app.documents.do.trashAll();
    await expect(app.documents.locators.rows).toHaveCount(0);

    await app.navigation.do.open('settings');
    await app.settings.do.openArchive();
    await expect(app.settings.locators.trash.items).toHaveCount(1);
    expect(fs.existsSync(note), "the user's original stays").toBe(true);
  });

  test('a deleted document lands in the trash and can be restored; emptying deletes it for good', async ({ on, page, workspace }, testInfo) => {
    const app = on(page);
    const archivedFile = path.join(workspace.dataDir, 'archive', 'Arbeit', 'Projekte', 'Nordlicht', 'jour-fixe.txt');
    const note = await trashArchivedNote(app, workspace);
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
    await expect(app.settings.locators.trash.compactionWarning).toHaveCount(0);
    expect(fs.readdirSync(path.join(workspace.dataDir, 'trash'))).toEqual([]);
    expect(fs.existsSync(note), "the user's original stays").toBe(true);
  });

  test('cancelling the emptying forgets the ticked confirmation', async ({ on, page, workspace }) => {
    const app = on(page);
    const trash = app.settings.locators.trash;
    await trashArchivedNote(app, workspace);
    await app.navigation.do.open('settings');
    await app.settings.do.openArchive();

    await trash.empty.click();
    await trash.confirmCheckbox.click();
    await expect(trash.confirmEmpty).toBeEnabled();
    await trash.cancelEmpty.click();
    await expect(trash.confirmDialog).toBeHidden();

    await trash.empty.click();
    await expect(trash.confirmCheckbox).not.toBeChecked();
    await expect(trash.confirmEmpty).toBeDisabled();
  });

  test('emptying says what is lost for good and warns when the database could not be compacted (#206)', async ({ on, page, workspace }, testInfo) => {
    const app = on(page);
    const trash = app.settings.locators.trash;
    await trashArchivedNote(app, workspace);
    await app.navigation.do.open('settings');
    await app.settings.do.openArchive();

    await trash.empty.click();
    await expect(trash.confirmDialog).toContainText('Papierkorb leeren und aus Archivist entfernen?');
    await expect(trash.confirmDialog).toContainText('Ein Dokument wird endgültig aus Archivist entfernt');
    await expect(trash.confirmDialog).toContainText('die Vorschauen im Übertragungsprotokoll');
    await expect(trash.confirmDialog).toContainText('Deine Originale außerhalb von Archivist bleiben unberührt. Ältere Backups enthalten den Text weiterhin.');
    await expect(trash.confirmEmpty).toBeDisabled();
    await expectNoSeriousA11yViolations(page, testInfo);
    await trash.cancelEmpty.click();
    await expect(trash.confirmDialog).toBeHidden();
    await expect(trash.items).toHaveCount(1);

    const releaseReader = holdDatabaseReader(workspace.dataDir);
    try {
      await app.settings.do.emptyTrash();
      await expect(trash.compactionWarning).toContainText('Die Dokumente sind entfernt, aber die Datenbank konnte nicht vollständig bereinigt werden.');
    } finally {
      releaseReader();
    }
    expect(fs.readdirSync(path.join(workspace.dataDir, 'trash'))).toEqual([]);
  });
});
