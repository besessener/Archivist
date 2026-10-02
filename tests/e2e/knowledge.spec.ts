import { expectNoSeriousA11yViolations } from './axe';
import { expect, test } from './fixture';

test.describe('knowledge: create new', () => {
  test('creates real entries and opens an existing one instead of claiming it was created', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('knowledge');
    const k = app.knowledge;

    await k.do.create('topic', 'Hauskauf');
    await expect(k.locators.toasts.filter({ hasText: 'Thema angelegt.' })).toBeVisible();
    await expect(k.heading()).toHaveText('Hauskauf');

    await k.do.create('topic', 'hauskauf');
    await expect(k.locators.toasts.filter({ hasText: 'Thema „Hauskauf“ existiert bereits.' })).toBeVisible();
    await expect(k.heading()).toHaveText('Hauskauf');
    await expect(k().filter({ hasText: /hauskauf/i })).toHaveCount(1);

    await k.do.create('note', 'Einkaufsliste', 'Milch und Brot');
    await expect(k.locators.toasts.filter({ hasText: 'Notiz angelegt.' })).toBeVisible();
    await expect(k.heading()).toHaveText('Einkaufsliste');

    await k.do.createEvent('Beitrag beim German Testing Day eingereicht', '2026-10-01');
    await expect(k.locators.toasts.filter({ hasText: 'Ereignis angelegt.' })).toBeVisible();
    await expect(k.heading()).toHaveText('Beitrag beim German Testing Day eingereicht');

    await app.navigation.do.open('timeline');
    await expect(app.timeline.entry('German Testing Day')).toHaveAttribute('data-kind', 'event');
  });

  test('shows the own person with the badge „Du“ (name from the setup)', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.locators.inputs.profileName.fill('Monika Lor-Zade');
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('knowledge');
    const k = app.knowledge;

    const me = k.locators.items.filter({ hasText: 'Monika Lor-Zade' });
    await expect(me.getByTestId('knowledge-item-self')).toHaveText('Du');
    await me.click();
    await expect(k.heading()).toHaveText('Monika Lor-Zade');
    await expect(k.locators.detail.getByTestId('entity-self')).toHaveText('Du');
  });

  test('offers similar entries as link proposals; „Verknüpfen“ confirms the link (#283, #313)', async ({ llm, on, page }, testInfo) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('knowledge');
    const k = app.knowledge;
    await k.do.create('note', 'Heizung Wartung', 'Die Heizung im Keller wurde von der Firma Kalt gewartet, der Brenner der Heizung wurde gereinigt.');
    await k.do.create('note', 'Heizung Brenner', 'Die Firma Kalt hat am Brenner der Heizung im Keller einen Defekt gefunden.');
    await expect(k.heading()).toHaveText('Heizung Brenner');

    const suggestion = page.getByTestId('link-suggestion').filter({ hasText: 'Heizung Wartung' });
    await expect(suggestion).toBeVisible();
    await expectNoSeriousA11yViolations(page, testInfo);
    await suggestion.getByRole('button', { name: 'Mit „Heizung Wartung“ verknüpfen' }).click();
    await expect(k.locators.toasts.filter({ hasText: 'Verknüpft.' })).toBeVisible();
    // linked now: no longer a proposal, but a related entry
    await expect(suggestion).toHaveCount(0);
    await expect(page.getByTestId('related-entry').filter({ hasText: 'Heizung Wartung' })).toBeVisible();
  });
});
