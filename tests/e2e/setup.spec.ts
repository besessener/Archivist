import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixture';

test.describe('setup on first launch', () => {
  test('shows the setup wizard and creates directories and database locally', async ({ on, page, workspace }) => {
    await expect(on(page).setup()).toBeVisible();

    for (const directory of ['archive', 'database', 'index', 'config', 'logs', 'backups', 'inbox', 'quarantine']) {
      expect(fs.existsSync(path.join(workspace.dataDir, directory)), directory).toBe(true);
    }
    expect(fs.existsSync(path.join(workspace.dataDir, 'database', 'archivist.db'))).toBe(true);
  });

  test('tests the connection to the LLM endpoint before continuing', async ({ llm, on, page }) => {
    const setup = on(page).setup;

    await setup.do.connectLlm(llm.url);

    await expect(setup.locators.texts.testResult).toContainText('erfolgreich');
  });

  test('warns when only the structured answers of the endpoint fail (#265)', async ({ llm, on, page }) => {
    const setup = on(page).setup;
    llm.structuredAnswers = false;

    await setup.do.connectLlm(llm.url);

    await expect(setup.locators.texts.testResult).toContainText('strukturierte Antworten fehlgeschlagen');
  });

  test('stores the API key encrypted and never in plain text', async ({ llm, on, page, workspace }) => {
    await on(page).setup.do.complete(llm.url);

    const settings = fs.readFileSync(path.join(workspace.dataDir, 'config', 'settings.json'), 'utf8');
    const encryptedKey = fs.readFileSync(path.join(workspace.dataDir, 'config', 'llm-api-key.enc'));
    expect(settings).not.toContain('SECRET');
    expect(encryptedKey.includes(Buffer.from('SECRET'))).toBe(false);
  });
});
