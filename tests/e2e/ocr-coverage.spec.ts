import fs from 'node:fs';
import path from 'node:path';
import { expectNoSeriousA11yViolations } from './axe';
import { expect, test } from './fixture';
import { multiPagePdfSource } from '../helpers/fixtures';

function savedOcrLanguages(dataDir: string): string {
  const settings = JSON.parse(fs.readFileSync(path.join(dataDir, 'config', 'settings.json'), 'utf8')) as { ocr: { languages: string } };
  return settings.ocr.languages;
}

test.describe('text recognition (OCR)', () => {
  test.beforeEach(async ({ llm, on, page }) => {
    await on(page).setup.do.complete(llm.url);
  });

  test('says which scanned pages stayed unread when a PDF is longer than the OCR limit (#226)', async ({ on, page, workspace }, testInfo) => {
    test.setTimeout(240_000);
    const app = on(page);
    const pages = [['Jour Fixe Nordlicht am 04.05.2026. Das Projekt Nordlicht wird fortgeführt.'], ...Array.from({ length: 44 }, () => [])];
    const file = workspace.addDownload('gescannt.pdf', multiPagePdfSource(pages));

    await app.inbox.do.importFile(file);
    await app.navigation.do.open('inbox');
    // 40 blank pages are rendered and recognised one by one first
    await expect(app.inbox.locators.proposals.first()).toBeVisible({ timeout: 180_000 });
    await app.inbox.do.waitForProposal('Arbeit/Projekte/Nordlicht');

    await expect(app.inbox.locators.coverage).toContainText('Texterkennung nicht ausgeführt');
    await expect(app.inbox.locators.coverage).toContainText('4 gescannten Seiten');
    await expect(app.inbox.locators.processingStatus).toHaveText('Text teilweise gelesen');
    await expectNoSeriousA11yViolations(page, testInfo);
  });

  test('offers the installed OCR languages and saves the choice', async ({ on, page, workspace }, testInfo) => {
    const app = on(page);
    await app.navigation.do.open('settings');
    await app.settings.do.openArchive();
    const { language, languages } = app.settings.locators.ocr;
    await expect(language('deu')).toBeChecked();
    await expect(language('eng')).toBeChecked();

    await language('eng').click();

    await expect.poll(() => savedOcrLanguages(workspace.dataDir)).toBe('deu');
    await expect(language('deu')).toBeDisabled();
    await expect(language('eng')).not.toBeChecked();
    await expect(languages).toBeVisible();
    await expectNoSeriousA11yViolations(page, testInfo);
  });
});
