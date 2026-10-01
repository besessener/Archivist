import { expect, test } from './fixture';

test.describe('Reminders', () => {
  test('pending reminders can be moved and dismissed on the open-items page and in the bell', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('open-items');
    const oi = app.openItems;

    await oi.do.create('Raum für den Workshop klären');
    await oi.do.create('Catering bestellen');
    await oi.do.remindTomorrow('Raum für den Workshop klären');
    await oi.do.remindTomorrow('Catering bestellen');

    const rows = oi.locators.upcoming.getByTestId('reminder-row');
    await expect(rows).toHaveCount(2);
    const room = rows.filter({ hasText: 'Raum für den Workshop' });
    await expect(room.getByTestId('reminder-when')).toContainText('morgen');

    // move: „In 7 Tagen“
    await room.getByTestId('reminder-snooze').click();
    await room.getByTestId('quick-week').click();
    await expect(room.getByTestId('reminder-when')).toContainText('in 7 Tagen');

    // dismiss on the page: gone from the list and from the item's badge
    await rows.filter({ hasText: 'Catering' }).getByTestId('reminder-dismiss').click();
    await expect(rows).toHaveCount(1);
    await expect(oi.row('Catering bestellen')).not.toContainText('Erinnerung');

    // the bell lists the remaining reminder and can dismiss it as well
    await oi.locators.buttons.bell.click();
    const bellRows = oi.locators.bellUpcoming.getByTestId('reminder-row');
    await expect(bellRows).toHaveCount(1);
    await expect(bellRows).toContainText('Raum für den Workshop klären');
    await bellRows.getByTestId('reminder-dismiss').click();
    await expect(oi.locators.bellUpcoming).toHaveCount(0);
    await page.keyboard.press('Escape');

    await expect(oi.locators.upcoming).toHaveCount(0);
    await expect(oi.row('Raum für den Workshop klären')).not.toContainText('Erinnerung');
  });
});
