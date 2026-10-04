import { expectNoSeriousA11yViolations } from './axe';
import { seedContradictions, seedLongLists } from './helpers';
import { expect, test as base } from './fixture';

/** 105 decisions, open insights, open items and messages of one conversation: more than one page of each. */
const test = base.extend({
  workspace: async ({ workspace }, provide) => {
    seedLongLists(workspace.dataDir, 105);
    await provide(workspace);
  },
});

test.describe('long lists load page by page (#223)', () => {
  test.beforeEach(async ({ llm, on, page }) => {
    await on(page).setup.do.complete(llm.url);
  });

  test('decisions show the newest 100 with „N von M“ and „Mehr laden“ adds the rest', async ({ on, page }) => {
    const app = on(page);
    await app.navigation.do.open('decisions');
    const decisions = app.decisions.locators;

    await expect(decisions.rows).toHaveCount(100);
    await expect(decisions.capped).toContainText('Angezeigt werden 100 von 105 Entscheidungen.');
    await expect(decisions.rows.filter({ hasText: 'Wir entscheiden Nummer 1.' })).toHaveCount(0);

    await decisions.loadMore.click();

    await expect(decisions.rows).toHaveCount(105);
    await expect(decisions.capped).toBeHidden();
  });

  test('insights show the newest 100 with „N von M“ and „Mehr laden“ adds the rest', async ({ on, page }) => {
    const app = on(page);
    await app.navigation.do.open('insights');
    const insights = app.insights.locators;

    await expect(insights.cards).toHaveCount(100);
    await expect(insights.capped).toContainText('Angezeigt werden 100 von 105 Hinweisen.');

    await insights.loadMore.click();

    await expect(insights.cards).toHaveCount(105);
    await expect(insights.capped).toBeHidden();
  });

  test('open items show the newest 100 with „N von M“ and „Mehr laden“ adds the rest', async ({ on, page }) => {
    const app = on(page);
    await app.navigation.do.open('open-items');
    const openItems = app.openItems.locators;

    await expect(openItems.rows).toHaveCount(100);
    await expect(openItems.capped).toContainText('Angezeigt werden 100 von 105 offenen Punkten.');

    await openItems.loadMore.click();

    await expect(openItems.rows).toHaveCount(105);
    await expect(openItems.capped).toBeHidden();
  });

  test('a long conversation shows its newest 100 messages and „Mehr laden“ adds the earlier ones above', async ({ on, page }) => {
    const app = on(page);
    await app.navigation.do.open('chat');
    const chat = app.chat.locators;

    await expect(chat.messages).toHaveCount(100);
    await expect(chat.history.capped).toContainText('Angezeigt werden 100 von 105 Nachrichten dieses Gesprächs.');
    await expect(chat.messages.first()).toContainText(/Nachricht 6(?!\d)/);
    await expect(chat.messages.last()).toContainText('Nachricht 105');

    await chat.history.loadMore.click();

    await expect(chat.messages).toHaveCount(105);
    await expect(chat.messages.first()).toContainText(/Nachricht 1(?!\d)/);
    await expect(chat.history.capped).toBeHidden();
  });

  test('the paged decisions and insights have no serious or critical violations', async ({ on, page }, testInfo) => {
    const app = on(page);
    await app.navigation.do.open('decisions');
    await expect(app.decisions.locators.capped).toBeVisible();
    await expectNoSeriousA11yViolations(page, testInfo);

    await app.navigation.do.open('insights');
    await expect(app.insights.locators.capped).toBeVisible();
    await expectNoSeriousA11yViolations(page, testInfo);
  });
});

/** Kept apart from the other lists: every contradiction also raises an insight. */
const withContradictions = base.extend({
  workspace: async ({ workspace }, provide) => {
    seedContradictions(workspace.dataDir, 105);
    await provide(workspace);
  },
});

withContradictions.describe('contradictions load page by page', () => {
  withContradictions('contradictions show the newest 100 with „N von M“ and „Mehr laden“ adds the rest', async ({ llm, on, page }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('insights');
    const contradictions = app.insights.locators.contradictions;

    await expect(contradictions.cards).toHaveCount(100);
    await expect(contradictions.capped).toContainText('Angezeigt werden 100 von 105 Widersprüchen.');
    await expect(contradictions.cards.filter({ hasText: /Widerspruch 1(?!\d)/ })).toHaveCount(0);

    await contradictions.loadMore.click();

    await expect(contradictions.cards).toHaveCount(105);
    await expect(contradictions.cards.filter({ hasText: /Widerspruch 1(?!\d)/ })).toHaveCount(1);
    await expect(contradictions.capped).toBeHidden();
  });
});

const beyondLimit = base.extend({
  workspace: async ({ workspace }, provide) => {
    seedLongLists(workspace.dataDir, 1005);
    await provide(workspace);
  },
});

beyondLimit.describe('lists past the IPC limit stay reachable (#223)', () => {
  beyondLimit.beforeEach(async ({ llm, on, page }) => {
    await on(page).setup.do.complete(llm.url);
  });

  beyondLimit('„Mehr laden“ pages by offset until the oldest of 1005 decisions is shown', async ({ on, page }) => {
    const app = on(page);
    await app.navigation.do.open('decisions');
    const decisions = app.decisions.locators;

    for (let shown = 100; shown < 1005; shown += 100) {
      await expect(decisions.rows).toHaveCount(shown);
      await decisions.loadMore.click();
    }

    await expect(decisions.rows).toHaveCount(1005);
    await expect(decisions.capped).toBeHidden();
    await expect(decisions.rows.getByText('Entscheidung 1', { exact: true })).toHaveCount(1);
  });
});
