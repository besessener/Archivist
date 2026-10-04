import { expect, test } from './fixture';
import { alterNewestAuditEntry, cutOffNewestAuditEntry } from './helpers';

test.describe('decisions: history, deleting and the change log', () => {
  test.beforeEach(async ({ llm, on, page }) => {
    await on(page).setup.do.complete(llm.url);
    await on(page).navigation.do.open('decisions');
  });

  test('a draft created in error can be deleted and brought back from the change log', async ({ on, page }) => {
    const { decisions: d, navigation, settings } = on(page);
    await d.do.createDraft('Versehentlich angelegt');
    await d.row('Versehentlich angelegt').click();

    await d.locators.buttons.delete.click();
    await expect(d.locators.confirmDialog).toContainText('Entscheidung löschen?');
    await d.locators.buttons.confirmDelete.click();
    await expect(d.row('Versehentlich angelegt')).toHaveCount(0);

    await navigation.do.open('settings');
    await settings.do.openAudit();
    const entry = settings.locators.audit.row('Entscheidung gelöscht');
    await expect(entry).toContainText('Versehentlich angelegt');
    await expect(settings.locators.audit.chainOk).toBeVisible();
    await settings.locators.audit.undoOf('Entscheidung gelöscht').click();
    await settings.locators.audit.confirmUndo.click();
    await expect(settings.locators.audit.row('Rückgängig: Entscheidung gelöscht')).toBeVisible();

    await navigation.do.open('decisions');
    await expect(d.row('Versehentlich angelegt')).toBeVisible();
  });

  test('warns in the change log when entries were cut off its end (#193)', async ({ on, page, workspace }) => {
    const { decisions: d, navigation, settings } = on(page);
    await d.do.createDraft('Wird protokolliert');
    await navigation.do.open('settings');
    await settings.do.openAudit();
    await expect(settings.locators.audit.chainOk).toBeVisible();

    cutOffNewestAuditEntry(workspace.dataDir);
    await navigation.do.open('decisions');
    await navigation.do.open('settings');
    await settings.do.openAudit();

    await expect(settings.locators.audit.chainBroken).toContainText('Es fehlen Einträge am Anfang oder Ende');
  });

  test('the change log shows the newest 100 entries and „Mehr laden“ adds the older ones', async ({ on, page }) => {
    const { navigation, settings, timeline } = on(page);
    const events = Array.from({ length: 105 }, (_, index) => ({ title: `Termin ${String(index + 1).padStart(3, '0')}`, occurredAt: '2026-09-01' }));
    await timeline.do.seedEvents(events);
    await navigation.do.open('settings');
    await settings.do.openAudit();

    await expect(settings.locators.audit.rows).toHaveCount(100);
    await expect(settings.locators.audit.row('Termin 105')).toHaveCount(1);
    await expect(settings.locators.audit.row('Termin 001')).toHaveCount(0);

    await settings.locators.audit.more.click();

    await expect(settings.locators.audit.row('Termin 001')).toHaveCount(1);
    await expect(settings.locators.audit.more).toBeHidden();
  });

  test('names a changed entry of the change log by its time and action, not by its id', async ({ on, page, workspace }) => {
    const { decisions: d, navigation, settings } = on(page);
    await d.do.createDraft('Wird verändert');
    alterNewestAuditEntry(workspace.dataDir);
    await navigation.do.open('settings');
    await settings.do.openAudit();

    await expect(settings.locators.audit.chainBroken).toContainText('erster betroffener Eintrag:');
    await expect(settings.locators.audit.chainBroken).toContainText('„Entscheidung angelegt“');
    await expect(settings.locators.audit.chainBroken).not.toContainText(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  test('a valid decision can be revoked but not deleted', async ({ on, page }) => {
    const d = on(page).decisions;
    await d.do.create({ text: 'Wir nutzen SQLite.', isoDate: '2026-10-01', topic: 'Datenbank', participants: 'Anna' });
    await d.row('Wir nutzen SQLite.').click();
    await expect(d.locators.buttons.edit).toBeVisible();
    await expect(d.locators.buttons.delete).toHaveCount(0);
  });

  test('the history tab shows what an edit changed, before and after', async ({ on, page }) => {
    const d = on(page).decisions;
    await d.do.create({ text: 'Wir nutzen Postgres.', isoDate: '2026-10-01', topic: 'Datenbank', participants: 'Anna' });
    await d.row('Wir nutzen Postgres.').click();
    await d.locators.buttons.edit.click();
    await d.locators.inputs.text.fill('Wir nutzen SQLite.');
    await d.locators.inputs.status.selectOption('confirmed');
    await d.locators.buttons.save.click();
    await expect(d.locators.form).toBeHidden();

    await d.locators.tabs.history.click();
    const edit = d.locators.history.entries.filter({ hasText: 'Entscheidung bearbeitet' });
    await expect(edit).toContainText('Entscheidung: Wir nutzen Postgres. → Wir nutzen SQLite.');
    await expect(edit).toContainText('Status: Gültig → Bestätigt');
    await expect(d.locators.history.entries.filter({ hasText: 'Entscheidung angelegt' })).toBeVisible();
    await expect(d.locators.detail).toContainText('Änderungen seit der Entscheidung');
  });

  test('a replaced decision names its successor; a draft cannot replace it', async ({ on, page }) => {
    const d = on(page).decisions;
    await d.do.create({ text: 'Wir nutzen Postgres.', isoDate: '2026-09-01', topic: 'Datenbank', participants: 'Anna' });
    await d.do.create({ text: 'Wir nutzen SQLite.', isoDate: '2026-10-01', topic: 'Datenbank', participants: 'Anna' });
    await d.do.createDraft('Wir nutzen vielleicht DuckDB.');

    await d.row('Wir nutzen Postgres.').click();
    await d.locators.buttons.edit.click();
    await d.locators.inputs.status.selectOption('superseded');
    await expect(d.locators.inputs.supersededBy.locator('option', { hasText: 'DuckDB' })).toHaveCount(0);
    await d.do.pickSupersededBy('SQLite');
    await d.locators.buttons.save.click();
    await d.locators.buttons.confirmStatus.click();
    await expect(d.locators.form).toBeHidden();

    await expect(d.locators.successor).toContainText('ersetzt durch Wir nutzen SQLite.');
    await d.locators.tabs.history.click();
    await expect(d.locators.history.entries.filter({ hasText: 'Entscheidung als ersetzt markiert' })).toBeVisible();
    await expect(d.locators.supersededByNote).toContainText('Wir nutzen SQLite.');
  });
});
