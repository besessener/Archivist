import { expectNoSeriousA11yViolations } from './axe';
import { expect, test } from './fixture';

/** Settings for the background agent and what Archivist has learned (#313, #315). */
test.describe('agent settings: limits per background task and learned entries', () => {
  test.beforeEach(async ({ llm, on, page }) => {
    await on(page).setup.do.complete(llm.url);
    await on(page).navigation.do.open('settings');
  });

  test('saves own limits for one background task and names the nightly run as the schedule of the tasks', async ({ on, page }) => {
    const settings = on(page).settings;
    await settings.do.openAgent();
    await expect(settings.locators.agent.nightlyHour).toBeVisible();
    await expect(page.getByText('Ohne Uhrzeit läuft nachts nichts.')).toBeVisible();

    await settings.locators.agent.kindLimit('Archivprüfung auswerten', 'Tokens').fill('100000');
    await settings.locators.agent.kindLimit('Archivprüfung auswerten', 'Runden').fill('12');
    await settings.locators.agent.save.click();
    await expect(page.getByText('Gespeichert').first()).toBeVisible();

    await page.reload();
    await settings.do.openAgent();
    await expect(settings.locators.agent.kindLimit('Archivprüfung auswerten', 'Tokens')).toHaveValue('100000');
    await expect(settings.locators.agent.kindLimit('Archivprüfung auswerten', 'Runden')).toHaveValue('12');
    await expect(settings.locators.agent.kindLimit('Neue Dateien einsortieren', 'Tokens')).toHaveValue('');

    await settings.locators.agent.kindLimit('Neue Dateien einsortieren', 'Tokens').fill('100');
    await expect(settings.locators.agent.validation).toContainText('Tokens zwischen 5.000');
    await expect(settings.locators.agent.save).toBeDisabled();
  });

  test('rules and workflows are edited in form fields: create, edit, switch off, export, delete and import', async ({ on, page }, testInfo) => {
    const settings = on(page).settings;
    await settings.do.openLearned();
    const rule = 'Stadtwerke → Energie';
    await settings.do.addRule({
      name: rule,
      content: 'Rechnungen der Stadtwerke immer nach private/energie',
      when: { 'Absender enthält': 'Stadtwerke' },
      then: { Ablageordner: 'private/energie', 'Schlagwörter (mit Komma getrennt)': 'Strom, Energie' },
    });
    await expect(settings.locators.memory.entry(rule)).toBeVisible();

    // a rule without condition or action is not saved
    await settings.locators.memory.newEntry.click();
    await settings.locators.memory.dialog.kind.selectOption('rule');
    await settings.locators.memory.dialog.name.fill('Leer');
    await settings.locators.memory.dialog.content.fill('nichts');
    await expect(settings.locators.memory.dialog.error).toContainText('mindestens eine Bedingung');
    await expect(settings.locators.memory.dialog.save).toBeDisabled();
    await expectNoSeriousA11yViolations(page, testInfo);
    await page.keyboard.press('Escape');

    // editing shows the stored fields
    await settings.locators.memory.edit(rule).click();
    await expect(settings.locators.memory.dialog.field('Absender enthält')).toHaveValue('Stadtwerke');
    await expect(settings.locators.memory.dialog.field('Schlagwörter (mit Komma getrennt)')).toHaveValue('Strom, Energie');
    await settings.locators.memory.dialog.field('Ablageordner').fill('private/finanzen/energie');
    await settings.locators.memory.dialog.content.fill('Rechnungen der Stadtwerke immer nach private/finanzen/energie');
    await settings.locators.memory.dialog.save.click();
    await settings.locators.memory.dialog.root.waitFor({ state: 'hidden' });
    await expect(settings.locators.memory.entry(rule)).toContainText('private/finanzen/energie');
    await settings.locators.memory.edit(rule).click();
    await expect(settings.locators.memory.dialog.field('Ablageordner')).toHaveValue('private/finanzen/energie');
    await page.keyboard.press('Escape');

    // a workflow with a weekday names the nightly run; with the nightly run off it warns
    await settings.locators.memory.newEntry.click();
    const { dialog } = settings.locators.memory;
    await dialog.kind.selectOption('workflow');
    await dialog.name.fill('Steuer-Mappe');
    await dialog.content.fill('Belege des Jahres sammeln');
    await page.getByLabel('Schritte (einer pro Zeile)').fill('Belege sammeln\nauf Lücken prüfen');
    await dialog.weekday.selectOption('1');
    await expect(dialog.nightlyOff).toBeVisible();
    await expectNoSeriousA11yViolations(page, testInfo);
    await dialog.save.click();
    await dialog.root.waitFor({ state: 'hidden' });
    await expect(settings.locators.memory.entry('Steuer-Mappe')).toBeVisible();

    // switch off keeps the entry
    await settings.locators.memory.use(rule).click();
    await expect(settings.locators.memory.entry(rule)).toContainText('aus');

    const exported = JSON.parse(await settings.do.exportLearned()) as Array<{ name: string; enabled: boolean; data: unknown }>;
    expect(exported.map((e) => e.name).sort()).toEqual([rule, 'Steuer-Mappe']);
    expect(exported.find((e) => e.name === rule)).toMatchObject({
      enabled: false,
      data: { when: { sender: 'Stadtwerke' }, then: { folder: 'private/finanzen/energie' } },
    });

    await settings.locators.memory.remove(rule).click();
    await settings.locators.memory.confirmDelete.click();
    await expect(settings.locators.memory.entry(rule)).toHaveCount(0);

    await settings.locators.memory.importInput.setInputFiles({
      name: 'gelernt.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(exported)),
    });
    await expect(settings.locators.memory.entry(rule)).toBeVisible();
    await expectNoSeriousA11yViolations(page, testInfo);
  });
});
