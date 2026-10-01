import { expect, test } from './fixture';

test.describe('Wissen: Neu anlegen', () => {
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
});
