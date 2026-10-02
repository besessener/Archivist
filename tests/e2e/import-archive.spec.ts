import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixture';

test.describe('import and archiving', () => {
  test.beforeEach(async ({ llm, on, page }) => {
    await on(page).setup.do.complete(llm.url);
  });

  test('proposes a target for an imported file and changes nothing before confirmation', async ({ on, page, workspace }) => {
    const app = on(page);
    const note = workspace.addDownload('jour-fixe.txt', 'Jour Fixe Nordlicht am 04.05.2026.\nTeilnehmer: Anna, Ben.\nDas Projekt Nordlicht wird fortgeführt.');
    const target = path.join(workspace.dataDir, 'archive', 'work', 'projects', 'Nordlicht', 'jour-fixe.txt');

    await app.inbox.do.importFile(note);
    await app.navigation.do.open('inbox');
    await app.inbox.do.waitForProposal('work/projects/Nordlicht');
    await expect(app.inbox.locators.llmStatus.first()).toContainText(/LLM analysiert/i);

    await app.inbox.do.openArchivePlan();
    await expect(app.inbox.locators.archivePlan.source.first()).toContainText('inbox');
    await expect(app.inbox.locators.archivePlan.target.first()).toContainText(path.join('work', 'projects', 'Nordlicht', 'jour-fixe.txt'));
    expect(fs.existsSync(target), 'nothing may be in the archive before confirmation').toBe(false);
  });

  test('archives after confirmation and leaves the original unchanged', async ({ on, page, workspace }) => {
    const app = on(page);
    const note = workspace.addDownload('jour-fixe.txt', 'Jour Fixe Nordlicht am 04.05.2026.\nTeilnehmer: Anna, Ben.\nDas Projekt Nordlicht wird fortgeführt.');
    const target = path.join(workspace.dataDir, 'archive', 'work', 'projects', 'Nordlicht', 'jour-fixe.txt');

    await app.inbox.do.importFile(note);
    await app.navigation.do.open('inbox');
    await app.inbox.do.waitForProposal('work/projects/Nordlicht');
    await app.inbox.do.openArchivePlan();
    await app.inbox.do.confirmArchive();

    expect(fs.readFileSync(target, 'utf8')).toContain('Jour Fixe');
    expect(fs.existsSync(note), 'the original is kept').toBe(true);
  });

  test('renames archived files of a multi-selection by a scheme, after a preview (#304)', async ({ on, page, workspace }) => {
    const app = on(page);
    const note = workspace.addDownload('jour-fixe.txt', 'Jour Fixe Nordlicht am 04.05.2026.\nTeilnehmer: Anna, Ben.\nDas Projekt Nordlicht wird fortgeführt.');
    const folder = path.join(workspace.dataDir, 'archive', 'work', 'projects', 'Nordlicht');

    await app.inbox.do.importFile(note);
    await app.navigation.do.open('inbox');
    await app.inbox.do.waitForProposal('work/projects/Nordlicht');
    await app.inbox.do.openArchivePlan();
    await app.inbox.do.confirmArchive();
    await app.inbox.locators.archivePlan.close.click();

    await app.navigation.do.open('documents');
    await expect(app.documents.locators.rows).toHaveCount(1);
    await app.documents.do.renameAll('{typ} {titel}', 'Protokoll Jour Fixe Nordlicht.txt');
    expect(fs.readdirSync(folder)).toEqual(['Protokoll Jour Fixe Nordlicht.txt']);
  });

  test('shows quarantined files with a reason and imports them only after confirmation', async ({ on, page, workspace }) => {
    const app = on(page);
    const fake = workspace.addDownload('rechnung.pdf', 'MZ das ist keine PDF-Datei');

    await app.inbox.do.importFile(fake);
    await app.navigation.do.open('inbox');
    await app.inbox.locators.quarantine.filter.click();
    await expect(app.inbox.locators.quarantine.filter).toContainText('(1)');
    await expect(app.inbox.locators.quarantine.badge).toBeVisible();
    await expect(app.inbox.locators.quarantine.reason).toContainText('Der Dateiinhalt passt nicht zur Endung „.pdf“.');
    await expect(app.inbox.locators.quarantine.reveal).toBeVisible();
    const quarantineDir = path.join(workspace.dataDir, 'quarantine');
    expect(fs.readdirSync(quarantineDir)).toEqual(['rechnung.pdf']);

    await app.inbox.do.releaseFromQuarantine();
    await expect(app.inbox.locators.quarantine.filter).toContainText('(0)');
    expect(fs.readdirSync(quarantineDir), 'the file has left quarantine').toEqual([]);
    expect(fs.readdirSync(path.join(workspace.dataDir, 'inbox'))).toEqual(['rechnung.pdf']);
  });

  test('respects an emptied project and only announces cleaning up the inbox copy', async ({ on, page, workspace }) => {
    const app = on(page);
    const note = workspace.addDownload('jour-fixe.txt', 'Jour Fixe Nordlicht am 04.05.2026.\nTeilnehmer: Anna, Ben.\nDas Projekt Nordlicht wird fortgeführt.');

    await app.inbox.do.importFile(note);
    await app.navigation.do.open('inbox');
    await app.inbox.do.waitForProposal('work/projects/Nordlicht');
    await expect(app.inbox.locators.fields.project.first()).toHaveValue('Nordlicht');
    await app.inbox.locators.fields.project.first().fill('');

    await app.inbox.do.openArchivePlan();
    await expect(app.inbox.locators.archivePlan.inboxCopy.first()).toHaveText('Inbox-Kopie wird aufgeräumt, Original bleibt erhalten');
    await expect(app.inbox.locators.archivePlan.removesSource).toHaveCount(0);
    await app.inbox.do.confirmArchive();
    await app.inbox.locators.archivePlan.close.click();
    expect(fs.existsSync(note), 'the original is kept').toBe(true);

    await app.navigation.do.open('documents');
    await expect(app.documents.locators.rows).toHaveCount(1);
    await expect(app.documents.locators.cell(0, 'Thema')).toHaveText('Nordlicht');
    await expect(app.documents.locators.cell(0, 'Projekt')).toHaveText('–');
  });
});
