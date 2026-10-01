import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixture';

test.describe('Import und Archivierung', () => {
  test.beforeEach(async ({ llm, on, page }) => {
    await on(page).setup.do.complete(llm.url);
  });

  test('schlägt für eine importierte Datei ein Ziel vor und verändert nichts vor der Bestätigung', async ({ on, page, workspace }) => {
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
    expect(fs.existsSync(target), 'vor der Bestätigung darf nichts im Archiv liegen').toBe(false);
  });

  test('archiviert nach der Bestätigung und lässt das Original unverändert', async ({ on, page, workspace }) => {
    const app = on(page);
    const note = workspace.addDownload('jour-fixe.txt', 'Jour Fixe Nordlicht am 04.05.2026.\nTeilnehmer: Anna, Ben.\nDas Projekt Nordlicht wird fortgeführt.');
    const target = path.join(workspace.dataDir, 'archive', 'work', 'projects', 'Nordlicht', 'jour-fixe.txt');

    await app.inbox.do.importFile(note);
    await app.navigation.do.open('inbox');
    await app.inbox.do.waitForProposal('work/projects/Nordlicht');
    await app.inbox.do.openArchivePlan();
    await app.inbox.do.confirmArchive();

    expect(fs.readFileSync(target, 'utf8')).toContain('Jour Fixe');
    expect(fs.existsSync(note), 'das Original bleibt erhalten').toBe(true);
  });
});
