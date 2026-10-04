import fs from 'node:fs';
import path from 'node:path';
import { expectNoSeriousA11yViolations } from './axe';
import { expect, test } from './fixture';

test.describe('scanning allowed directories', () => {
  test.beforeEach(async ({ llm, on, page, workspace }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url, 'confirm');
    await app.navigation.do.open('scan');
    await app.scan.do.allowDirectory(path.basename(workspace.downloads));
  });

  test('finds new files and skips known, unchanged ones', async ({ on, page, workspace }) => {
    const scan = on(page).scan;
    workspace.addDownload('urlaub.txt', 'Urlaubsantrag für den 12.06.2026, bitte genehmigen.');
    workspace.addDownload('notiz.txt', 'Eine kurze Notiz.');

    await scan.do.scan();
    await expect(scan.locators.fileRows).toHaveCount(2, { timeout: 30_000 });

    await scan.do.scan();
    await expect(scan.locators.summary).toContainText(/unverändert/i, { timeout: 30_000 });
  });

  test('analyses a file only with explicit LLM permission and proposes a target', async ({ on, page, workspace }) => {
    const scan = on(page).scan;
    workspace.addDownload('urlaub.txt', 'Urlaubsantrag für den 12.06.2026, bitte genehmigen.');
    await scan.do.scan();
    await expect(scan.locators.fileRows).toHaveCount(1, { timeout: 30_000 });

    await scan.do.analyzeWithLlm('urlaub.txt');

    await expect(scan.locators.proposals.first()).toBeVisible({ timeout: 30_000 });
  });

  test('shows the first 500 files and loads the rest on request', async ({ on, page, workspace }) => {
    const scan = on(page).scan;
    for (let index = 0; index < 501; index += 1)
      workspace.addDownload(`datei-${String(index).padStart(3, '0')}.txt`, `Datei Nummer ${index} mit eigenem Inhalt.`);

    await scan.do.scan();
    await expect(scan.locators.fileRows).toHaveCount(500, { timeout: 60_000 });
    await expect(scan.locators.resultsCount).toContainText('500 von 501');

    await scan.locators.buttons.loadMore.click();
    await expect(scan.locators.fileRows).toHaveCount(501);
    await expect(scan.locators.buttons.loadMore).toHaveCount(0);
  });
});

test.describe('analysing selected files in the privacy mode „automatisch“', () => {
  test.beforeEach(async ({ llm, on, page, workspace }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url, 'auto');
    await app.navigation.do.open('scan');
    await app.scan.do.allowDirectory(path.basename(workspace.downloads));
  });

  test('says that the selection goes to the AI instead of offering a local-only analysis', async ({ llm, on, page, workspace }, testInfo) => {
    const scan = on(page).scan;
    workspace.addDownload('urlaub.txt', 'Urlaubsantrag für den 12.06.2026, bitte genehmigen.');
    await scan.do.scan();
    await expect(scan.locators.fileRows).toHaveCount(1, { timeout: 30_000 });

    await scan.do.openAnalysis('urlaub.txt');

    await expect(scan.locators.automaticNote).toBeVisible();
    await expect(scan.locators.allowLlm).toHaveCount(0);
    await expect(scan.locators.buttons.confirmAnalysis).toHaveText('Mit KI analysieren');
    await expectNoSeriousA11yViolations(page, testInfo);
    await scan.locators.buttons.confirmAnalysis.click();
    await expect(scan.locators.analyzedRows).toHaveCount(1, { timeout: 30_000 });
    expect(llm.calls.filter((call) => call.schema === 'DocumentClassification')).toHaveLength(1);
  });

  test('archives a project group with each document keeping its own topic', async ({ on, page, workspace }) => {
    const { scan, navigation, documents } = on(page);
    workspace.addDownload('jourfixe.txt', 'Protokoll des Jour Fixe zum Projekt Nordlicht.');
    workspace.addDownload('budget.txt', 'Budgetplanung für das Projekt Nordlicht.');
    await scan.do.scan();
    await expect(scan.locators.fileRows).toHaveCount(2, { timeout: 30_000 });
    await scan.do.openAnalysis('jourfixe.txt', 'budget.txt');
    await scan.locators.buttons.confirmAnalysis.click();
    await expect(scan.locators.analyzedRows).toHaveCount(2, { timeout: 30_000 });

    await scan.do.archiveProposal('Nordlicht');

    await navigation.do.open('documents');
    await expect(documents.locators.rows).toHaveCount(2);
    const topics = async () => [await documents.locators.cell(0, 'Thema').innerText(), await documents.locators.cell(1, 'Thema').innerText()].sort();
    await expect.poll(topics).toEqual(['Budget', 'Nordlicht']);
  });
});

test.describe('analysing all new files at once (#228)', () => {
  test.beforeEach(async ({ llm, on, page, workspace }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url, 'confirm');
    await app.navigation.do.open('scan');
    await app.scan.do.allowDirectory(path.basename(workspace.downloads));
    for (const name of ['a', 'b', 'c'])
      workspace.addDownload(`akte-${name}.txt`, `Akte ${name}: Urlaubsantrag für den 12.06.2026, bitte genehmigen (${name}).`);
    await app.scan.do.scan();
    await expect(app.scan.locators.fileRows).toHaveCount(3, { timeout: 30_000 });
  });

  test('asks once with count and token estimate, analyses everything and reports once', async ({ llm, on, page }, testInfo) => {
    const { scan, notifications } = on(page);

    await scan.do.openAnalyzeAll();
    await expect(scan.locators.analyzeAll.estimate).toContainText('3 von 3 Dateien');
    await expect(scan.locators.analyzeAll.estimate).toContainText('Token');
    await expectNoSeriousA11yViolations(page, testInfo);
    await scan.locators.analyzeAll.allowLlm.check();
    await scan.locators.analyzeAll.confirm.click();

    await expect(scan.locators.analyzedRows).toHaveCount(3, { timeout: 30_000 });
    expect(llm.calls.filter((call) => call.schema === 'DocumentClassification')).toHaveLength(3);
    await expect(async () => {
      await notifications.do.open();
      await expect(notifications.item('Analyse abgeschlossen')).toContainText('3 Dokumente analysiert, 0 Fehler', { timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
    await expect(notifications.item('Klassifikation bereit')).toHaveCount(0);
    await expect(notifications.item('Analyse abgeschlossen')).toHaveCount(1);
    await expectNoSeriousA11yViolations(page, testInfo);
    await notifications.locators.markAllRead.click();
    await expect(notifications.locators.count).toBeHidden();
    await expect(notifications.item('Analyse abgeschlossen')).toHaveAttribute('data-read', 'true');
    await notifications.do.close();
    await expect(scan.locators.analyzeAll.button).toBeHidden();
  });

  test('archives all proposals of the scan after one confirmation and keeps the originals', async ({ on, page, workspace }, testInfo) => {
    const { scan } = on(page);
    await scan.do.openAnalyzeAll();
    await scan.locators.analyzeAll.allowLlm.check();
    await scan.locators.analyzeAll.confirm.click();
    await expect(scan.locators.analyzedRows).toHaveCount(3, { timeout: 30_000 });

    await scan.locators.archiveAll.open.click();
    await expect(scan.locators.archiveAll.preview).toContainText('Deine Originale bleiben unverändert');
    await expect(scan.locators.archiveAll.folders).toContainText('Arbeit/Projekte/Nordlicht/');
    await expect(scan.locators.archiveAll.folders).toContainText('3 Dokumente');
    await expect(scan.locators.archiveAll.confirm, 'needs the review confirmation first').toBeDisabled();
    await expectNoSeriousA11yViolations(page, testInfo);
    await scan.locators.archiveAll.reviewed.check();
    await scan.locators.archiveAll.confirm.click();

    const archived = path.join(workspace.dataDir, 'archive', 'Arbeit', 'Projekte', 'Nordlicht');
    await expect(async () => {
      expect(fs.readdirSync(archived).sort()).toEqual(['akte-a.txt', 'akte-b.txt', 'akte-c.txt']);
    }).toPass({ timeout: 30_000 });
    await expect(scan.locators.archiveAll.open).toBeHidden();
    for (const name of ['a', 'b', 'c']) expect(fs.existsSync(path.join(workspace.downloads, `akte-${name}.txt`)), 'the original is kept').toBe(true);
  });

  test('sends nothing to the LLM without the consent', async ({ llm, on, page }) => {
    const { scan } = on(page);

    await scan.do.openAnalyzeAll();
    await scan.locators.analyzeAll.confirm.click();

    await expect(scan.locators.analyzedRows).toHaveCount(3, { timeout: 30_000 });
    expect(llm.calls.filter((call) => call.schema === 'DocumentClassification')).toHaveLength(0);
  });
});
