import path from 'node:path';
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
