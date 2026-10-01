import { expect, test } from './fixture';

test.describe('Timeline', () => {
  test('ein erfasstes Ereignis mit Datum erscheint als Ereignis in der Timeline', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('timeline');

    await app.timeline.do.addEvent('Beitrag beim German Testing Day eingereicht', '2026-10-01');

    await expect(app.timeline.entry('German Testing Day')).toHaveAttribute('data-kind', 'event');
  });
});
