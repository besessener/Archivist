import type { Page } from '@playwright/test';
import type { ArchivistBridge } from '@archivist/shared';
import { expect, test } from './fixture';

const QUESTION = 'Ist ‚prod-plat‘ ein Projekt oder ein Thema?';

/** Creates the topic „prod-plat“ and the project „Prod Plat“ through the app's IPC bridge. */
async function seedTopicAndProject(page: Page) {
  await page.evaluate(async () => {
    const bridge = (window as unknown as { archivist: ArchivistBridge }).archivist;
    await bridge.invoke('knowledge:createEntity', { type: 'topic', name: 'prod-plat' });
    await bridge.invoke('knowledge:createEntity', { type: 'project', name: 'Prod Plat' });
  });
}

/** Types of the knowledge entries named like „prod plat“. */
const entryTypes = (page: Page) =>
  page.evaluate(async () => {
    const bridge = (window as unknown as { archivist: ArchivistBridge }).archivist;
    const res = await bridge.invoke('knowledge:listEntities', { query: 'prod plat', limit: 50 });
    return res.ok ? res.data.map((e) => e.type).sort() : [];
  });

test.describe('insights: question with several answers', () => {
  test.beforeEach(async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await seedTopicAndProject(page);
    await app.navigation.do.open('insights');
    await app.insights.do.runCheck();
  });

  test('„Projekt“ merges topic and project into one project after confirmation', async ({ on, page }) => {
    const app = on(page);
    const card = app.insights.card(QUESTION);
    await expect(app.insights.choices(card)).toHaveText(['Projekt', 'Thema', 'Beides ist richtig (verschieden)'], { timeout: 30_000 });

    await app.insights.do.choose(card, { label: 'Projekt', confirm: true });

    expect(await entryTypes(page)).toEqual(['project']);
    await app.insights.do.showStatus('accepted');
    await expect(card.getByTestId('insight-chosen')).toHaveText('Antwort: Projekt');
  });

  test('„Beides ist richtig“ keeps both entries and remembers the answer', async ({ on, page }) => {
    const app = on(page);
    const card = app.insights.card(QUESTION);
    await expect(app.insights.choices(card)).toHaveCount(3, { timeout: 30_000 });

    await app.insights.do.choose(card, { label: 'Beides ist richtig', confirm: false });

    expect(await entryTypes(page)).toEqual(['project', 'topic']);
    await app.insights.do.showStatus('rejected');
    await expect(card.getByTestId('insight-chosen')).toHaveText('Antwort: Beides ist richtig (verschieden)');
  });
});
