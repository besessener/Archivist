import path from 'node:path';
import { expectNoSeriousA11yViolations } from './axe';
import { expect, test } from './fixture';

test.describe('scanning allowed directories', () => {
  test.beforeEach(async ({ llm, on, page, workspace }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
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

  test('sends nothing to the LLM without the consent', async ({ llm, on, page }) => {
    const { scan } = on(page);

    await scan.do.openAnalyzeAll();
    await scan.locators.analyzeAll.confirm.click();

    await expect(scan.locators.analyzedRows).toHaveCount(3, { timeout: 30_000 });
    expect(llm.calls.filter((call) => call.schema === 'DocumentClassification')).toHaveLength(0);
  });
});
