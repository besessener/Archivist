import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixture';

function savedReminderTime(dataDir: string): string {
  const settings = JSON.parse(fs.readFileSync(path.join(dataDir, 'config', 'settings.json'), 'utf8')) as { notifications: { reminderTime: string } };
  return settings.notifications.reminderTime;
}

test.describe('reminder time', () => {
  test('can be configured and is saved (#77)', async ({ llm, on, page, workspace }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('settings');
    await app.settings.do.openNotifications();
    await expect(app.settings.locators.notifications.reminderTime).toHaveValue('08:00');

    await app.settings.do.setReminderTime('07:30');

    await expect.poll(() => savedReminderTime(workspace.dataDir)).toBe('07:30');
    await expect(app.settings.locators.notifications.reminderTime).toHaveValue('07:30');
  });
});
