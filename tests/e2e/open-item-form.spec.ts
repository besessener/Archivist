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

  test('closed items sit in a collapsed „Erledigt“ group that opens on click', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('open-items');
    const oi = app.openItems;
    await oi.do.create('Angebot einholen');

    await oi.row('Angebot einholen').getByTestId('open-item-close').click();
    await oi.locators.closeConfirm.click();

    await expect(oi.locators.doneToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(oi.row('Angebot einholen')).toBeHidden();
    await oi.locators.doneToggle.click();
    await expect(oi.locators.doneToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(oi.row('Angebot einholen')).toBeVisible();
  });

  test('a scrolled dialog keeps its title and „Schließen“ button visible and clickable', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('open-items');
    const oi = app.openItems;
    await page.setViewportSize({ width: 900, height: 420 });

    await oi.locators.buttons.create.click();
    const scroller = oi.locators.form.locator('> div').first();
    await scroller.evaluate((element) => element.scrollTo(0, element.scrollHeight));
    const title = oi.locators.form.getByRole('heading');
    const close = oi.locators.form.getByRole('button', { name: 'Schließen' });
    await expect(title).toBeInViewport({ ratio: 1 });
    await expect(close).toBeInViewport({ ratio: 1 });
    const formTop = (await oi.locators.form.boundingBox())!.y;
    const titleTop = (await title.boundingBox())!.y;
    expect(titleTop - formTop).toBeLessThan(40);

    await close.click();
    await expect(oi.locators.form).toBeHidden();
  });
});
