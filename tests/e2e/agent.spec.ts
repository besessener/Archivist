import fs from 'node:fs';
import path from 'node:path';
import { expectNoSeriousA11yViolations } from './axe';
import { expect, test } from './fixture';

/** The agent mode in the chat (#300): live steps, summary with undo, stop, questions with answer buttons. */
test.describe('chat: agent mode', () => {
  test('shows the steps live with details, then a summary whose undo takes the change back', async ({ llm, on, page, workspace }, testInfo) => {
    llm.agentTurns = [
      { calls: [{ name: 'find_documents', args: { name: 'notiz' } }] },
      // a slow second round: the live view stays visible long enough to look at it
      { calls: [{ name: 'create_folder', args: { path: 'work/notizen' } }], delayMs: 2_500 },
      { text: 'Ich habe den Ordner work/notizen angelegt.' },
    ];
    await on(page).setup.do.complete(llm.url);
    const app = on(page);

    await app.chat.do.send('Leg mir einen Ordner work/notizen an');
    await expect(app.chat.locators.agent.steps.first()).toContainText('Suche Dokumente „notiz“');
    await expect(app.chat.locators.agent.steps.first()).toContainText('keine gefunden');
    await expect(app.chat.locators.agent.announcement).toBeAttached();
    await expect(app.chat.locators.agent.usage).toContainText('Tokens');
    await app.chat.do.showStepDetails(0);
    await expect(app.chat.locators.agent.steps.first()).toContainText('find_documents');
    await expectNoSeriousA11yViolations(page, testInfo);

    await expect(app.chat.locators.agent.summary).toBeVisible({ timeout: 15_000 });
    await expect(app.chat.do.lastReply()).toContainText('work/notizen angelegt');
    await expect(app.chat.locators.agent.summary).toContainText('Lege den Ordner work/notizen an');
    await expectNoSeriousA11yViolations(page, testInfo);

    await app.chat.do.undoLastRun();
    await expect(app.chat.locators.agent.undoResult).toContainText('1');
    expect(fs.existsSync(path.join(workspace.dataDir, 'archive', 'work', 'notizen'))).toBe(false);
  });

  test('„Stopp“ ends the run; what is done stays and is named', async ({ llm, on, page }) => {
    llm.agentTurns = [{ calls: [{ name: 'create_folder', args: { path: 'work/stopp' } }] }, { text: 'Weiter.', delayMs: 20_000 }];
    await on(page).setup.do.complete(llm.url);
    const app = on(page);

    await app.chat.do.send('Leg work/stopp an und mach dann weiter');
    await expect(app.chat.locators.agent.steps.first()).toContainText('angelegt');
    await app.chat.locators.agent.stop.click();
    await expect(app.chat.locators.thinking).toBeHidden({ timeout: 10_000 });
    await expect(app.chat.do.lastReply()).toContainText('Ordner work/stopp angelegt');
    await expect(app.chat.locators.agent.summary).toContainText('Lege den Ordner work/stopp an');
  });

  test('a question of the agent comes with answer buttons; the answer continues the run', async ({ llm, on, page }) => {
    llm.agentTurns = [
      { calls: [{ name: 'ask_user', args: { question: 'Soll ich den Ordner work/fragen anlegen?', options: ['Ja', 'Nein'] } }] },
      { text: 'Gut, dann lasse ich es.' },
    ];
    await on(page).setup.do.complete(llm.url);
    const app = on(page);

    await app.chat.do.send('Brauche ich einen Ordner für Fragen?');
    await expect(app.chat.do.lastReply()).toContainText('Soll ich den Ordner work/fragen anlegen?');
    await expect(app.chat.locators.agent.quickReplies).toHaveCount(2);
    await app.chat.locators.agent.quickReplies.filter({ hasText: 'Nein' }).click();
    await expect(app.chat.do.lastReply()).toContainText('dann lasse ich es');
  });

  test('a running run is still visible after switching tabs and after reloading the window', async ({ llm, on, page }) => {
    llm.agentTurns = [{ calls: [{ name: 'find_documents', args: { name: 'brief' } }] }, { text: 'Fertig.', delayMs: 6_000 }];
    await on(page).setup.do.complete(llm.url);
    const app = on(page);

    await app.chat.do.send('Such meine Briefe');
    await expect(app.chat.locators.agent.steps.first()).toContainText('Suche Dokumente „brief“');
    await app.navigation.do.open('decisions');
    await app.navigation.do.open('chat');
    await expect(app.chat.locators.agent.steps.first()).toContainText('Suche Dokumente „brief“');
    await page.reload();
    await expect(app.chat.locators.agent.steps.first()).toContainText('Suche Dokumente „brief“');
    await expect(app.chat.do.lastReply()).toContainText('Fertig.', { timeout: 15_000 });
  });
});
