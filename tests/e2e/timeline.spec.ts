import { expect, test } from './fixture';

test.describe('Timeline', () => {
  test('ein erfasstes Ereignis mit Datum erscheint als Ereignis in der Timeline', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('timeline');

    await app.timeline.do.addEvent('Beitrag beim German Testing Day eingereicht', '2026-10-01');

    await expect(app.timeline.entry('German Testing Day')).toHaveAttribute('data-kind', 'event');
  });

  test('zeigt zuerst die neuesten Einträge und lädt ältere auf Wunsch nach', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('timeline');

    // 205 events on consecutive days: more than one page (200 entries) of the timeline
    const events = Array.from({ length: 205 }, (_, i) => ({
      title: `Serienereignis ${String(i).padStart(3, '0')}`,
      occurredAt: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
    }));
    await app.timeline.do.seedEvents(events);

    await expect(app.timeline.entry('Serienereignis 204')).toBeVisible();
    await expect(app.timeline.entry('Serienereignis 000')).toHaveCount(0);
    await expect(app.timeline.locators.buttons.loadOlder).toBeVisible();

    await app.timeline.do.loadOlder();

    await expect(app.timeline.entry('Serienereignis 000')).toBeVisible();
    await expect(app.timeline.entry('Serienereignis 204')).toBeVisible();
    await expect(app.timeline.locators.buttons.loadOlder).toHaveCount(0);
  });
});
