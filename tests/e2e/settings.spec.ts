import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixture';

test.describe('Einstellungen', () => {
  test('die Uhrzeit für Erinnerungen ist einstellbar und wird gespeichert (#77)', async ({ llm, on, page, workspace }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('settings');
    await app.settings.locators.tabs.notifications.click();

    await expect(app.settings.locators.inputs.reminderTime).toHaveValue('08:00');
    await app.settings.do.setReminderTime('07:30');

    const settings = JSON.parse(fs.readFileSync(path.join(workspace.dataDir, 'config', 'settings.json'), 'utf8')) as {
      notifications: { reminderTime: string };
    };
    expect(settings.notifications.reminderTime).toBe('07:30');
    await expect(app.settings.locators.inputs.reminderTime).toHaveValue('07:30');
  });
});
