import fs from 'node:fs';
import path from 'node:path';
import { expectNoSeriousA11yViolations } from './axe';
import { expect, test } from './fixture';

const NORDLICHT = (n: number) => `Jour Fixe Nordlicht am 04.05.2026 (${n}).\nTeilnehmer: Anna, Ben.\nDas Projekt Nordlicht wird fortgeführt.`;

test.describe('archiving all proposals at once (#228)', () => {
  test.beforeEach(async ({ llm, on, page }) => {
    await on(page).setup.do.complete(llm.url);
  });

  test('shows count and target structure, archives after one confirmation and keeps the originals', async ({ on, page, workspace }, testInfo) => {
    const { inbox, navigation } = on(page);
    const originals = [1, 2, 3].map((n) => workspace.addDownload(`jour-fixe-${n}.txt`, NORDLICHT(n)));

    await inbox.do.importFiles(originals);
    await navigation.do.open('inbox');
    await expect(inbox.locators.proposals).toHaveCount(3, { timeout: 30_000 });
    await inbox.locators.archiveAll.open.click();

    await expect(inbox.locators.archiveAll.preview).toContainText('Deine Originale bleiben unverändert');
    await expect(inbox.locators.archiveAll.folders).toContainText('Arbeit/Projekte/Nordlicht/');
    await expect(inbox.locators.archiveAll.folders).toContainText('3 Dokumente');
    await expect(inbox.locators.archiveAll.confirm).toContainText('3 Dokumente archivieren');
    await expect(inbox.locators.archiveAll.confirm, 'needs the review confirmation first').toBeDisabled();
    await expectNoSeriousA11yViolations(page, testInfo);
    expect(fs.existsSync(path.join(workspace.dataDir, 'archive', 'Arbeit')), 'nothing is archived before the confirmation').toBe(false);

    await inbox.locators.archiveAll.reviewed.check();
    await inbox.locators.archiveAll.confirm.click();

    await expect(inbox.locators.items).toHaveCount(0, { timeout: 30_000 });
    expect(fs.readdirSync(path.join(workspace.dataDir, 'archive', 'Arbeit', 'Projekte', 'Nordlicht')).sort()).toEqual([
      'jour-fixe-1.txt',
      'jour-fixe-2.txt',
      'jour-fixe-3.txt',
    ]);
    for (const original of originals) expect(fs.existsSync(original), 'the original is kept').toBe(true);
  });
});

test.describe('archiving all proposals: new main categories (#228)', () => {
  test.beforeEach(async ({ llm, on, page, workspace }) => {
    await on(page).setup.do.complete(llm.url);
    const { inbox, navigation } = on(page);
    await inbox.do.importFiles([workspace.addDownload('jour-fixe-1.txt', NORDLICHT(1)), workspace.addDownload('neuordner-1.txt', NORDLICHT(2))]);
    await navigation.do.open('inbox');
    await expect(inbox.locators.proposals).toHaveCount(2, { timeout: 30_000 });
    await inbox.locators.archiveAll.open.click();
  });

  test('a new main category is created only when it is ticked; without it that document stays in the inbox', async ({ on, page, workspace }, testInfo) => {
    const { inbox } = on(page);

    await expect(inbox.locators.archiveAll.newCategory).toHaveCount(1);
    await expect(inbox.locators.archiveAll.newCategory).not.toBeChecked();
    await expectNoSeriousA11yViolations(page, testInfo);
    await inbox.locators.archiveAll.reviewed.check();
    await inbox.locators.archiveAll.confirm.click();

    await expect(inbox.locators.items).toHaveCount(1, { timeout: 30_000 });
    expect(fs.existsSync(path.join(workspace.dataDir, 'archive', 'Arbeit', 'Projekte', 'Nordlicht', 'jour-fixe-1.txt'))).toBe(true);
    expect(fs.existsSync(path.join(workspace.dataDir, 'archive', 'sonderfall')), 'the unapproved folder is not created').toBe(false);
  });

  test('a ticked new main category is created', async ({ on, page, workspace }) => {
    const { inbox } = on(page);

    await inbox.locators.archiveAll.newCategory.check();
    await inbox.locators.archiveAll.reviewed.check();
    await inbox.locators.archiveAll.confirm.click();

    await expect(inbox.locators.items).toHaveCount(0, { timeout: 30_000 });
    expect(fs.existsSync(path.join(workspace.dataDir, 'archive', 'sonderfall', 'akten', 'neuordner-1.txt'))).toBe(true);
  });
});

test.describe('long inbox (#228)', () => {
  test('pages through more than 200 documents instead of cutting the list off', async ({ llm, on, page, workspace }) => {
    test.setTimeout(180_000);
    const { inbox, navigation, setup } = on(page);
    await setup.do.complete(llm.url, 'local_only');
    for (let n = 1; n <= 205; n += 1) workspace.addDownload(`akte-${String(n).padStart(3, '0')}.txt`, `Akte Nummer ${n} mit eigenem Inhalt ${n * 7919}.`);

    await inbox.locators.folderPick.click();
    await inbox.locators.closeImportCard.click();
    await navigation.do.open('inbox');

    await expect(inbox.locators.paging.info).toContainText('200 von 205', { timeout: 120_000 });
    await expect(inbox.locators.items).toHaveCount(200);

    await inbox.locators.paging.loadMore.click();

    await expect(inbox.locators.items).toHaveCount(205);
    await expect(inbox.locators.paging.info).toBeHidden();
  });
});

test.describe('long scan result list (#228)', () => {
  test('pages over all results and offers „erneut analysieren“ for analysed files', async ({ llm, on, page, workspace }, testInfo) => {
    test.setTimeout(180_000);
    const { scan, navigation, setup } = on(page);
    await setup.do.complete(llm.url, 'confirm');
    await navigation.do.open('scan');
    await scan.do.allowDirectory(path.basename(workspace.downloads));
    for (let n = 1; n <= 501; n += 1) workspace.addDownload(`datei-${String(n).padStart(3, '0')}.txt`, `Datei ${n} mit eigenem Inhalt ${n * 104729}.`);

    await scan.do.scan();
    await expect(scan.locators.paging.info).toContainText('500 von 501', { timeout: 120_000 });
    await expect(scan.locators.fileRows).toHaveCount(500);
    await scan.locators.paging.loadMore.click();
    await expect(scan.locators.fileRows).toHaveCount(501);
    await expect(scan.locators.paging.info).toBeHidden();

    await scan.locators.fileRows.first().getByTestId('scan-file-checkbox').check();
    await scan.locators.buttons.analyze.click();
    await scan.locators.buttons.confirmAnalysis.click();
    await expect(scan.locators.analyzedRows).toHaveCount(1, { timeout: 30_000 });

    await scan.locators.analyzedRows.first().getByTestId('scan-file-checkbox').check();
    await scan.locators.buttons.analyze.click();
    await expect(scan.locators.reanalyze).toBeVisible();
    await expectNoSeriousA11yViolations(page, testInfo);
  });
});

test.describe('analysing an import with the LLM afterwards (#228)', () => {
  test('the folder import offers „Alle N mit KI analysieren“ in „vorher fragen“ and uses the usual consent', async ({ llm, on, page, workspace }, testInfo) => {
    const { inbox, navigation, notifications, setup } = on(page);
    await setup.do.complete(llm.url, 'confirm');
    for (let n = 1; n <= 3; n += 1) workspace.addDownload(`akte-${n}.txt`, NORDLICHT(n));

    await inbox.locators.folderPick.click();
    await inbox.locators.closeImportCard.click();
    await navigation.do.open('inbox');
    await expect(inbox.locators.items).toHaveCount(3, { timeout: 30_000 });
    expect(llm.calls.filter((call) => call.schema === 'DocumentClassification')).toHaveLength(0);

    await expect(async () => {
      await notifications.do.open();
      await expect(notifications.item('Ordner').getByRole('button', { name: 'Alle 3 mit KI analysieren' })).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
    await notifications.item('Ordner').getByRole('button', { name: 'Alle 3 mit KI analysieren' }).click();

    await expect(inbox.locators.analyzeImport.estimate).toContainText('3 von 3 Dokumente');
    await expect(inbox.locators.analyzeImport.budget).toContainText('kein Tageslimit');
    await expectNoSeriousA11yViolations(page, testInfo);
    await inbox.locators.analyzeImport.allowLlm.check();
    await inbox.locators.analyzeImport.confirm.click();

    await expect(async () => {
      expect(llm.calls.filter((call) => call.schema === 'DocumentClassification')).toHaveLength(3);
    }).toPass({ timeout: 30_000 });
  });
});

test.describe('older notifications (#228)', () => {
  test('the bell loads more than the latest 50 on request', async ({ llm, on, page, workspace }, testInfo) => {
    test.setTimeout(180_000);
    const { inbox, notifications, setup } = on(page);
    await setup.do.complete(llm.url);
    for (let n = 1; n <= 52; n += 1) {
      await inbox.do.importFile(workspace.addDownload(`einzeln-${n}.txt`, `Einzelne Datei ${n} mit eigenem Inhalt ${n * 6007}.`));
      await inbox.locators.closeImportCard.click();
    }

    await expect(async () => {
      await notifications.do.open();
      await expect(notifications.locators.items).toHaveCount(50, { timeout: 1_000 });
    }).toPass({ timeout: 60_000 });
    await expect(notifications.locators.loadOlder).toBeVisible();
    await expectNoSeriousA11yViolations(page, testInfo);

    await notifications.locators.loadOlder.click();

    await expect(notifications.locators.items).not.toHaveCount(50);
    await expect(notifications.locators.loadOlder).toBeHidden();
  });
});
