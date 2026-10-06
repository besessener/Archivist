import { expect, test } from './fixture';

test.describe('open items: the form', () => {
  test('a new item keeps an owner and a due date marked as unknown', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('open-items');
    const oi = app.openItems;

    await oi.locators.buttons.create.click();
    await oi.locators.inputs.title.fill('Dachrinne reparieren');
    await oi.locators.inputs.responsibleUnknown.click();
    await oi.locators.inputs.dueUnknown.click();
    await oi.locators.buttons.save.click();
    await expect(oi.locators.form).toBeHidden();

    const row = oi.row('Dachrinne reparieren');
    await expect(row).toContainText('Verantwortlicher bewusst unbekannt');
    await expect(row).toContainText('Termin bewusst unbekannt');
    await expect(row.getByTestId('badge-no-owner')).toHaveCount(0);
    await expect(row.getByTestId('badge-no-due')).toHaveCount(0);
  });

  test('deleting an item asks first and removes it only after confirming', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('open-items');
    const oi = app.openItems;
    await oi.do.create('Alte Idee');
    await expect(app.navigation.locators.count('open-items')).toHaveText('1');

    await oi.row('Alte Idee').getByTestId('open-item-delete').click();
    await page.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(oi.row('Alte Idee')).toBeVisible();

    await oi.do.remove('Alte Idee');
    await expect(app.navigation.locators.count('open-items')).toHaveCount(0);
  });
});
