import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import type { PageTree } from './pages';
import { expect, test } from './fixture';

const NOTE = 'Jour Fixe Nordlicht am 04.05.2026.\nTeilnehmer: Anna, Ben.\nDas Projekt Nordlicht wird fortgeführt.';

/** Imports a note and archives it into work/projects/Nordlicht, then opens Settings → Archiv. */
async function archiveNoteAndOpenSettings(app: PageTree, page: Page, file: string): Promise<void> {
  await app.inbox.do.importFile(file);
  await app.navigation.do.open('inbox');
  await app.inbox.do.waitForProposal('work/projects/Nordlicht');
  await app.inbox.do.openArchivePlan();
  await app.inbox.do.confirmArchive();
  await page.keyboard.press('Escape'); // close the result dialog
  await app.navigation.do.open('settings');
  await app.settings.do.openArchive();
}

test.describe('Archive root', () => {
  test.beforeEach(async ({ llm, on, page }) => {
    await on(page).setup.do.complete(llm.url);
  });

  test('offers moving the archive or only changing the path, and moves it with undo', async ({ on, page, workspace }) => {
    const app = on(page);
    const rel = path.join('work', 'projects', 'Nordlicht', 'jour-fixe.txt');
    const oldRoot = path.join(workspace.dataDir, 'archive');
    const newRoot = path.join(path.dirname(workspace.dataDir), 'NAS', 'Archiv');
    await archiveNoteAndOpenSettings(app, page, workspace.addDownload('jour-fixe.txt', NOTE));
    expect(fs.existsSync(path.join(oldRoot, rel))).toBe(true);
    const root = app.settings.locators.archiveRoot;

    // Cancel leaves everything as it is.
    await app.settings.do.startArchiveRootChange(newRoot);
    await expect(root.dialog.pathWarning).toContainText('1 archiviertes Dokument fehlt im neuen Ordner');
    await expect(root.dialog.pathOnly).toBeDisabled();
    await root.dialog.cancel.click();
    await expect(root.dialog.root).toBeHidden();
    expect(fs.existsSync(newRoot), 'nothing is created before a choice is confirmed').toBe(false);

    // Move the archive.
    await app.settings.do.startArchiveRootChange(newRoot);
    await root.dialog.migrate.click();
    await expect(root.lastChange).toContainText('umgezogen', { timeout: 60_000 });
    await expect(root.input).toHaveValue(newRoot);
    expect(fs.readFileSync(path.join(newRoot, rel), 'utf8')).toContain('Jour Fixe');
    expect(fs.existsSync(path.join(oldRoot, rel)), 'the old folder stays untouched').toBe(true);
    await expect(root.unreachable).toBeHidden();

    // Undo switches back and removes the copy.
    await root.undo.click();
    await expect(root.input).toHaveValue(oldRoot);
    await expect.poll(() => fs.existsSync(path.join(newRoot, rel))).toBe(false);
  });

  test('warns with the number of affected documents when only the path is changed', async ({ on, page, workspace }) => {
    const app = on(page);
    const emptyRoot = path.join(path.dirname(workspace.dataDir), 'Leer');
    await archiveNoteAndOpenSettings(app, page, workspace.addDownload('jour-fixe.txt', NOTE));
    const root = app.settings.locators.archiveRoot;

    await app.settings.do.startArchiveRootChange(emptyRoot);
    await expect(root.dialog.pathWarning).toContainText('1 archiviertes Dokument fehlt');
    await root.dialog.accept.click();
    await root.dialog.pathOnly.click();

    await expect(root.input).toHaveValue(emptyRoot);
    await expect(root.unreachable).toContainText('fehlt 1 von 1 Dokument');
  });
});
