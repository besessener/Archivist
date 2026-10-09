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

  test('an overdue item stands out: red stripe, red navigation counter, secondary actions as named icon buttons', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('open-items');
    await expect(app.navigation.locators.pageTile).toHaveAttribute('data-tone', 'task');
    const oi = app.openItems;
    await oi.do.create('Zählerstand melden');
    await expect(app.navigation.locators.count('open-items')).toHaveAttribute('data-emphasis', 'normal');

    const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString('sv-SE');
    await oi.locators.buttons.create.click();
    await oi.locators.inputs.title.fill('Paket abholen');
    await oi.locators.inputs.due.fill(tomorrow);
    await oi.locators.buttons.save.click();
    await expect(oi.locators.form).toBeHidden();
    await expect(app.navigation.locators.count('open-items')).toHaveAttribute('data-emphasis', 'warning');
    await expect(app.navigation.locators.count('open-items')).toHaveAttribute('aria-label', '2 offen, davon 1 bald fällig');

    const yesterday = new Date(Date.now() - 86_400_000).toLocaleDateString('sv-SE');
    await oi.locators.buttons.create.click();
    await oi.locators.inputs.title.fill('Steuererklärung abgeben');
    await oi.locators.inputs.due.fill(yesterday);
    await oi.locators.buttons.save.click();
    await expect(oi.locators.form).toBeHidden();

    const overdue = oi.row('Steuererklärung abgeben');
    await expect(overdue).toHaveAttribute('data-group', 'overdue');
    await expect(overdue).toHaveAttribute('data-stripe', 'danger');
    await expect(oi.row('Zählerstand melden')).not.toHaveAttribute('data-stripe');
    await expect(app.navigation.locators.count('open-items')).toHaveAttribute('data-emphasis', 'urgent');
    await expect(app.navigation.locators.count('open-items')).toHaveAttribute('aria-label', '3 offen, davon 1 überfällig, 1 bald fällig');
    for (const name of ['Bearbeiten', 'Erinnern', 'Zusammenhänge', 'Löschen …']) await expect(overdue.getByRole('button', { name })).toBeVisible();
  });

  test('the „Bald fällig“ window follows the setting', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('open-items');
    const oi = app.openItems;
    const inTenDays = new Date(Date.now() + 10 * 86_400_000).toLocaleDateString('sv-SE');
    await oi.locators.buttons.create.click();
    await oi.locators.inputs.title.fill('Vertrag kündigen');
    await oi.locators.inputs.due.fill(inTenDays);
    await oi.locators.buttons.save.click();
    await expect(oi.locators.form).toBeHidden();
    await expect(oi.row('Vertrag kündigen')).toHaveAttribute('data-group', 'open');

    await app.navigation.do.open('settings');
    await app.settings.do.openArchive();
    await expect(app.settings.locators.consistency.dueSoonDays).toHaveValue('7');
    await app.settings.locators.consistency.dueSoonDays.fill('14');
    await app.settings.locators.consistency.save.click();

    await app.navigation.do.open('open-items');
    await expect(oi.row('Vertrag kündigen')).toHaveAttribute('data-group', 'due');
  });

  test('deleting an item asks first and removes it only after confirming', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('open-items');
    const oi = app.openItems;
    await oi.do.create('Alte Idee');
    await expect(app.navigation.locators.count('open-items')).toHaveText('1');

    await oi.do.cancelDelete('Alte Idee');
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
