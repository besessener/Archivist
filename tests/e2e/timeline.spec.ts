import { expect, test } from './fixture';

test.describe('Timeline', () => {
  test('a recorded event with a date appears as an event in the timeline', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('timeline');

    await app.timeline.do.addEvent('Beitrag beim German Testing Day eingereicht', '2026-10-01');

    await expect(app.timeline.entry('German Testing Day')).toHaveAttribute('data-kind', 'event');
  });

  test('an event can be edited: title, date, description, topic and project', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('timeline');
    const tl = app.timeline;

    await tl.do.addEvent('Abstract eingereicht', '2026-10-01');
    await tl.do.editEvent('Abstract eingereicht', {
      title: 'Vortrag beim Testing Day eingereicht',
      date: '2026-09-15',
      description: 'Folien folgen',
      topic: 'Konferenzen',
      project: 'Testing Day',
    });

    await expect(tl.entry('Abstract eingereicht')).toHaveCount(0);
    const edited = tl.entry('Vortrag beim Testing Day eingereicht');
    await expect(edited).toHaveAttribute('data-kind', 'event');
    await expect(edited).toContainText('15. September 2026');
    await expect(edited).toContainText('Folien folgen');

    // the dialog opens prefilled with the stored values
    await edited.getByTestId('event-edit').click();
    await expect(tl.locators.inputs.eventTitle).toHaveValue('Vortrag beim Testing Day eingereicht');
    await expect(tl.locators.inputs.eventDate).toHaveValue('2026-09-15');
    await expect(tl.locators.inputs.eventDescription).toHaveValue('Folien folgen');
    await expect(tl.locators.inputs.eventTopic).toHaveValue('Konferenzen');
    await expect(tl.locators.inputs.eventProject).toHaveValue('Testing Day');
  });

  test('an event description is rendered as Markdown after saving', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('timeline');
    const tl = app.timeline;

    await tl.do.addEvent('Workshop vorbereitet', '2026-10-01');
    await tl.do.editEvent('Workshop vorbereitet', { description: 'Agenda ist **fertig**\n\n- Raum gebucht\n- Catering bestellt' });

    const description = tl.entry('Workshop vorbereitet').getByTestId('timeline-description');
    await expect(description.locator('strong')).toHaveText('fertig');
    await expect(description.locator('li')).toHaveText(['Raum gebucht', 'Catering bestellt']);
    await expect(description).not.toContainText('**');
  });

  test('a Markdown table in an event description is rendered as a table', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('timeline');
    const tl = app.timeline;

    await tl.do.addEvent('Folien gesichtet', '2026-10-01');
    await tl.do.editEvent('Folien gesichtet', { description: '| Datei | Ordner |\n|---|---|\n| Sovereign AI.pptx | sovereign-ai |' });

    const description = tl.entry('Folien gesichtet').getByTestId('timeline-description');
    await expect(description.locator('th')).toHaveText(['Datei', 'Ordner']);
    await expect(description.locator('td')).toHaveText(['Sovereign AI.pptx', 'sovereign-ai']);
    await expect(description).not.toContainText('|');
  });

  test('shows the newest entries first and loads older ones on request', async ({ llm, on, page }) => {
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
