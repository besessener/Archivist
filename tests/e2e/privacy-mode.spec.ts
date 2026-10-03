import fs from 'node:fs';
import path from 'node:path';
import { expectNoSeriousA11yViolations } from './axe';
import { expect, test } from './fixture';

function savedPrivacy(dataDir: string): { llmMode: string; maskPersonalData?: boolean } {
  const settings = JSON.parse(fs.readFileSync(path.join(dataDir, 'config', 'settings.json'), 'utf8')) as {
    privacy: { llmMode: string; maskPersonalData?: boolean };
  };
  return settings.privacy;
}
const savedMode = (dataDir: string): string => savedPrivacy(dataDir).llmMode;

test.describe('privacy mode', () => {
  test('is saved immediately on selection and shown as active', async ({ llm, on, page, workspace }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('settings');
    await app.settings.do.openPrivacy();
    await expect(app.settings.locators.privacy.activeMode).toContainText('Automatisch analysieren');

    await app.settings.do.selectMode('local_only');

    await expect(app.settings.locators.privacy.activeMode).toContainText('Aktiver Modus: Nur lokal');
    await expect.poll(() => savedMode(workspace.dataDir)).toBe('local_only');

    // Leaving the page without pressing any save button keeps the mode.
    await app.navigation.do.open('timeline');
    await app.navigation.do.open('settings');
    await app.settings.do.openPrivacy();
    await expect(app.settings.locators.privacy.mode('local_only')).toBeChecked();
    await expect(app.settings.locators.privacy.activeMode).toContainText('Nur lokal');
  });

  test('does not discard unsaved input under „Nie analysieren“ when switching the mode', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('settings');
    await app.settings.do.openPrivacy();
    await app.settings.locators.privacy.extensions.fill('xlsx, eml');

    await app.settings.do.selectMode('confirm');

    await expect(app.settings.locators.privacy.activeMode).toContainText('Vor jeder externen Analyse fragen');
    await expect(app.settings.locators.privacy.extensions).toHaveValue('xlsx, eml');
  });

  test('masks personal data by default, says what stays readable and can be switched off', async ({ llm, on, page, workspace }, testInfo) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('settings');
    await app.settings.do.openPrivacy();

    await expect(app.settings.locators.privacy.maskPersonal).toBeChecked();
    await expect(app.settings.locators.privacy.maskNote).toContainText('Gesundheitsdaten');
    await expect(app.settings.locators.privacy.maskNote).toContainText('nicht maskiert');
    await expectNoSeriousA11yViolations(page, testInfo);

    await app.settings.locators.privacy.maskPersonal.click();

    await expect(app.settings.locators.privacy.maskPersonal).not.toBeChecked();
    await expect.poll(() => savedPrivacy(workspace.dataDir).maskPersonalData).toBe(false);
  });
});
