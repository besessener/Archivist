import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixture';

test.describe('Einrichtung beim ersten Start', () => {
  test('zeigt den Einrichtungsdialog und legt Verzeichnisse und Datenbank lokal an', async ({ on, page, workspace }) => {
    await expect(on(page).setup()).toBeVisible();

    for (const directory of ['archive', 'database', 'index', 'config', 'logs', 'backups', 'inbox', 'quarantine']) {
      expect(fs.existsSync(path.join(workspace.dataDir, directory)), directory).toBe(true);
    }
    expect(fs.existsSync(path.join(workspace.dataDir, 'database', 'archivist.db'))).toBe(true);
  });

  test('prüft die Verbindung zum LLM-Endpunkt, bevor es weitergeht', async ({ llm, on, page }) => {
    const setup = on(page).setup;

    await setup.do.connectLlm(llm.url);

    await expect(setup.locators.texts.testResult).toContainText('erfolgreich');
  });

  test('speichert den API-Schlüssel verschlüsselt und nie im Klartext', async ({ llm, on, page, workspace }) => {
    await on(page).setup.do.complete(llm.url);

    const settings = fs.readFileSync(path.join(workspace.dataDir, 'config', 'settings.json'), 'utf8');
    const encryptedKey = fs.readFileSync(path.join(workspace.dataDir, 'config', 'llm-api-key.enc'));
    expect(settings).not.toContain('SECRET');
    expect(encryptedKey.includes(Buffer.from('SECRET'))).toBe(false);
  });
});
