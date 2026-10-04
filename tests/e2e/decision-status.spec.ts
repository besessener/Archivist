import { expect, test } from './fixture';

test.describe('decisions: status change in the form', () => {
  test('revoking and superseding only go through a confirmation dialog', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('decisions');
    const d = app.decisions;

    await d.do.create({ text: 'Wir nutzen Postgres.', isoDate: '2026-09-01', topic: 'Datenbank', participants: 'Anna, Ben' });
    await d.do.create({ text: 'Wir nutzen SQLite.', isoDate: '2026-10-01', topic: 'Datenbank', participants: 'Anna' });

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

  test('choosing „Entwurf“ or back „Gültig“ in the status select saves exactly that status', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('decisions');
    const d = app.decisions;
    await d.do.create({ text: 'Wir nutzen Postgres.', isoDate: '2026-09-01', topic: 'Datenbank', participants: 'Anna' });
    await expect(d.row('Wir nutzen Postgres.')).toHaveAttribute('data-status', 'active');

    await d.row('Wir nutzen Postgres.').click();
    await d.locators.buttons.edit.click();
    await d.locators.inputs.status.selectOption('draft');
    await expect(d.locators.inputs.draft).toBeChecked();
    await d.locators.buttons.save.click();
    await expect(d.locators.form).toBeHidden();
    await expect(d.row('Wir nutzen Postgres.')).toHaveAttribute('data-status', 'draft');

    await d.locators.buttons.edit.click();
    await d.locators.inputs.status.selectOption('active');
    await expect(d.locators.inputs.draft).not.toBeChecked();
    await d.locators.buttons.save.click();
    await expect(d.locators.form).toBeHidden();
    await expect(d.row('Wir nutzen Postgres.')).toHaveAttribute('data-status', 'active');
  });

  test('ticking and unticking „Als Entwurf speichern“ returns to the original status', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('decisions');
    const d = app.decisions;
    await d.do.create({ text: 'Wir nutzen Postgres.', isoDate: '2026-09-01', topic: 'Datenbank', participants: 'Anna' });
    await expect(d.row('Wir nutzen Postgres.')).toHaveAttribute('data-status', 'active');

    await d.row('Wir nutzen Postgres.').click();
    await d.locators.buttons.edit.click();
    await d.locators.inputs.draft.check();
    await expect(d.locators.inputs.status).toHaveValue('draft');
    await d.locators.inputs.draft.uncheck();
    await expect(d.locators.inputs.status).toHaveValue('active');
    await d.locators.buttons.save.click();
    await expect(d.locators.form).toBeHidden();
    await expect(d.row('Wir nutzen Postgres.')).toHaveAttribute('data-status', 'active');
  });

  test('the picked successor stays selected when a new search no longer finds it', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('decisions');
    const d = app.decisions;
    await d.do.create({ text: 'Wir nutzen Postgres.', isoDate: '2026-09-01', topic: 'Datenbank', participants: 'Anna' });
    await d.do.create({ text: 'Wir nutzen SQLite.', isoDate: '2026-10-01', topic: 'Datenbank', participants: 'Anna' });
    await d.do.create({ text: 'Wir nutzen Redis.', isoDate: '2026-10-02', topic: 'Cache', participants: 'Ben' });

    await d.row('Wir nutzen Postgres.').click();
    await d.locators.buttons.edit.click();
    await d.locators.inputs.status.selectOption('superseded');
    const { supersededBy, supersededBySearch } = d.locators.inputs;
    await supersededBySearch.fill('SQLite');
    await expect(supersededBy.locator('option', { hasText: 'Redis' })).toHaveCount(0);
    await d.do.pickSupersededBy('SQLite');

    await supersededBySearch.fill('Redis');
    await expect(supersededBy.locator('option', { hasText: 'Redis' })).toHaveCount(1);
    await expect(supersededBy.locator('option:checked')).toHaveText(/Wir nutzen SQLite\./);

    await d.locators.buttons.save.click();
    await d.locators.buttons.confirmStatus.click();
    await expect(d.row('Wir nutzen Postgres.')).toHaveAttribute('data-status', 'superseded');
  });
});
