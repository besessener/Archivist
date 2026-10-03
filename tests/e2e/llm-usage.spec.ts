import fs from 'node:fs';
import path from 'node:path';
import { expectNoSeriousA11yViolations } from './axe';
import { expect, test } from './fixture';

function savedLlm(dataDir: string): { reasoningEffort: string | null; dailyTokenCap: number | null } {
  const settings = JSON.parse(fs.readFileSync(path.join(dataDir, 'config', 'settings.json'), 'utf8')) as {
    llm: { reasoningEffort: string | null; dailyTokenCap: number | null };
  };
  return settings.llm;
}

test.describe('token use and thinking depth (#153, #154)', () => {
  test('the privacy tab shows the tokens used today and this month and saves an optional daily limit', async ({ llm, on, page, workspace }, testInfo) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('settings');
    await app.settings.do.openLlm();
    await app.settings.locators.llm.testConnection.click();
    await expect(app.settings.locators.llm.testResult).toBeVisible();

    await app.settings.do.openPrivacy();

    await expect(app.settings.locators.privacy.usageToday).toContainText(/[1-9][\d.]* Tokens/);
    await expect(app.settings.locators.privacy.usageToday).toContainText('Anfragen');
    await expect(app.settings.locators.privacy.usageMonth).toContainText(/[1-9][\d.]* Tokens/);
    expect(savedLlm(workspace.dataDir).dailyTokenCap).toBeNull();

    await app.settings.locators.privacy.capInput.fill('12');
    await expect(app.settings.locators.privacy.capError).toContainText('ab 1.000');
    await expect(app.settings.locators.privacy.capSave).toBeDisabled();
    await expectNoSeriousA11yViolations(page, testInfo);

    await app.settings.locators.privacy.capInput.fill('50000');
    await app.settings.locators.privacy.capSave.click();
    await expect.poll(() => savedLlm(workspace.dataDir).dailyTokenCap).toBe(50_000);

    await app.settings.locators.privacy.capInput.fill('');
    await app.settings.locators.privacy.capSave.click();
    await expect.poll(() => savedLlm(workspace.dataDir).dailyTokenCap).toBeNull();
  });

  test('the thinking depth offers „sehr hoch“ and „maximal“ and keeps „keine“ as a value of its own', async ({ llm, on, page, workspace }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('settings');
    await app.settings.do.openLlm();
    const { effort, save } = app.settings.locators.llm;

    await effort.selectOption('max');
    await save.click();
    await expect.poll(() => savedLlm(workspace.dataDir).reasoningEffort).toBe('max');
    await expect(save).toBeEnabled();

    await effort.selectOption('none');
    await save.click();
    await expect.poll(() => savedLlm(workspace.dataDir).reasoningEffort).toBe('none');
    await expect(save).toBeEnabled();

    await effort.selectOption('');
    await save.click();
    await expect.poll(() => savedLlm(workspace.dataDir).reasoningEffort).toBeNull();
    await expect(effort.locator('option')).toHaveText([
      'Standard des Modells',
      'keine (wird gesendet)',
      'minimal',
      'niedrig',
      'mittel',
      'hoch',
      'sehr hoch',
      'maximal',
    ]);
  });

  test('with the daily limit reached the chat asks before it sends anything and continues on request', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('settings');
    await app.settings.do.openLlm();
    await app.settings.locators.llm.testConnection.click();
    await expect(app.settings.locators.llm.testResult).toBeVisible();
    await app.settings.do.openPrivacy();
    await app.settings.locators.privacy.capInput.fill('1000');
    await app.settings.locators.privacy.capSave.click();
    await expect(app.settings.locators.privacy.capSave).toBeEnabled();

    await app.navigation.do.open('chat');
    const requestsBefore = llm.calls.length;
    await app.chat.do.send('Hallo Archivist');

    await expect(app.chat.do.lastReply()).toContainText('Tageslimit');
    expect(llm.calls).toHaveLength(requestsBefore);
    await app.chat.locators.agent.quickReplies.getByText('Trotzdem fortfahren').click();
    await expect.poll(() => llm.calls.length).toBeGreaterThan(requestsBefore);
    await expect(app.chat.do.lastReply()).not.toContainText('Tageslimit');
  });
});
