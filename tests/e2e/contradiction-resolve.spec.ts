import { expect, test } from './fixture';

const PAUSE = 'Wir pausieren das Projekt Nordlicht.';
const CONTINUE = 'Wir führen das Projekt Nordlicht weiter.';

test.describe('contradictions: resolving a pair of decisions', () => {
  test.beforeEach(async ({ llm, on, page }) => {
    await on(page).setup.do.complete(llm.url);
    await on(page).navigation.do.open('decisions');
  });

  test('decision dates on different days pre-select that the newer decision supersedes the older', async ({ on, page }) => {
    const app = on(page);
    await app.decisions.do.create({ text: PAUSE, isoDate: '2026-05-01', topic: 'Nordlicht', participants: 'Anna' });
    await app.decisions.do.create({ text: CONTINUE, isoDate: '2026-06-01', topic: 'Nordlicht', participants: 'Anna' });

    await app.navigation.do.open('insights');
    await app.insights.locators.contradictions.resolve.click();
    const dialog = app.insights.locators.resolveDialog;
    await expect(dialog.supersede).toBeChecked();
    await expect(dialog.root).toContainText(/Neu: Wir führen das Projekt Nordlicht weiter.*Alt: Wir pausieren das Projekt Nordlicht/s);
  });

  test('two decisions of the same day do not pre-select which one supersedes the other', async ({ on, page }) => {
    const app = on(page);
    await app.decisions.do.create({ text: PAUSE, isoDate: '2026-05-01', topic: 'Nordlicht', participants: 'Anna' });
    await app.decisions.do.create({ text: CONTINUE, isoDate: '2026-05-01', topic: 'Nordlicht', participants: 'Anna' });

    await app.navigation.do.open('insights');
    await app.insights.locators.contradictions.resolve.click();
    await expect(app.insights.locators.resolveDialog.supersede).not.toBeChecked();
  });
});
