import { expect, test } from './fixture';

test.describe('decisions: hints on the detail view (#192)', () => {
  test.beforeEach(async ({ llm, on, page }) => {
    await on(page).setup.do.complete(llm.url);
    await on(page).navigation.do.open('decisions');
  });

  test('both decisions of a contradictory pair name the open contradiction', async ({ on, page }) => {
    const d = on(page).decisions;
    await d.do.create({ text: 'Wir pausieren das Projekt Nordlicht.', isoDate: '2026-05-01', topic: 'Nordlicht', participants: 'Anna' });
    await d.row('Wir pausieren das Projekt Nordlicht.').click();
    await expect(d.locators.hints.root).toHaveCount(0);

    await d.do.create({ text: 'Wir führen das Projekt Nordlicht weiter.', isoDate: '2026-06-01', topic: 'Nordlicht', participants: 'Anna' });

    for (const text of ['Wir führen das Projekt Nordlicht weiter.', 'Wir pausieren das Projekt Nordlicht.']) {
      await d.row(text).click();
      await expect(d.locators.hints.contradiction).toContainText('Offener Widerspruch');
    }
  });

  test('the older of two decisions on a topic shows „möglicherweise überholt“ after the archive check', async ({ on, page }) => {
    const app = on(page);
    const d = app.decisions;
    await d.do.create({ text: 'Wir treffen uns montags.', isoDate: '2026-05-01', topic: 'Jour fixe', participants: 'Anna' });
    await d.do.create({ text: 'Wir treffen uns dienstags.', isoDate: '2026-06-01', topic: 'Jour fixe', participants: 'Anna' });

    await app.navigation.do.open('insights');
    await app.insights.do.runCheck();
    await expect(app.insights.card('Möglicherweise überholt')).toBeVisible({ timeout: 30_000 });

    await app.navigation.do.open('decisions');
    await d.row('Wir treffen uns dienstags.').click();
    await expect(d.locators.hints.superseded).toHaveCount(0);
    await d.row('Wir treffen uns montags.').click();
    await expect(d.locators.hints.superseded).toContainText('Wir treffen uns dienstags.');
  });
});
