import { expect, test } from './fixture';

test.describe('Entscheidungen: Statuswechsel im Formular', () => {
  test('Widerrufen und Ersetzen laufen nur über einen Bestätigungsdialog', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('decisions');
    const d = app.decisions;

    await d.do.create('Wir nutzen Postgres.', '2026-09-01', 'Datenbank', 'Anna, Ben');
    await d.do.create('Wir nutzen SQLite.', '2026-10-01', 'Datenbank', 'Anna');

    // revoke: cancelling the dialog changes nothing
    await d.row('Wir nutzen Postgres.').click();
    await d.locators.buttons.edit.click();
    await d.locators.inputs.status.selectOption('revoked');
    await d.locators.buttons.save.click();
    await expect(d.locators.confirmDialog).toContainText('Entscheidung widerrufen?');
    await d.locators.confirmDialog.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(d.locators.confirmDialog).toBeHidden();
    await expect(d.locators.form).toBeVisible();

    // supersede: needs the newer decision, then the confirmation
    await d.locators.inputs.status.selectOption('superseded');
    await expect(d.locators.buttons.save).toBeDisabled();
    await d.do.pickSupersededBy('SQLite');
    await d.locators.buttons.save.click();
    await expect(d.locators.confirmDialog).toContainText('als ersetzt markieren?');
    await d.locators.buttons.confirmStatus.click();
    await expect(d.locators.form).toBeHidden();
    await expect(d.row('Wir nutzen Postgres.')).toHaveAttribute('data-status', 'superseded');

    // a superseded decision cannot be reactivated by editing
    await expect(d().getByText('Ersetzt', { exact: true }).first()).toBeVisible();
    await d.locators.buttons.edit.click();
    await expect(d.locators.inputs.status).toBeDisabled();
  });
});
