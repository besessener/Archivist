import { expectNoSeriousA11yViolations } from './axe';
import { expect, test } from './fixture';
import type { PageTree } from './pages';

const DECISION = 'Die Fassade wird im Herbst gestrichen.';
const NOTIFICATION = 'Dokument enthält 1 mögliche Entscheidung(en)';

/** Imports and archives a document in which the (fake) LLM finds one decision; the proposal and its notification follow. */
async function archiveDocumentWithDecision(app: PageTree, file: string) {
  await app.inbox.do.importFile(file);
  await app.navigation.do.open('inbox');
  await app.inbox.do.waitForProposal('Arbeit/Projekte/Nordlicht');
  await app.inbox.do.openArchivePlan();
  await app.inbox.do.confirmArchive();
  await app.inbox.locators.archivePlan.close.click();
}

test.describe('decisions found in documents', () => {
  test.beforeEach(async ({ llm, on, page, workspace }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await archiveDocumentWithDecision(app, workspace.addDownload('beschluss.txt', `Protokoll\nBeschluss: ${DECISION}`));
  });

  test('are reviewed on their own page, reached from the notification, and confirmed there', async ({ on, page }, testInfo) => {
    const app = on(page);
    await app.notifications.do.open();
    await expect(app.notifications.item(NOTIFICATION)).toBeVisible();

    await app.notifications.locators.actions.navigate.click();
    await expect(page.getByRole('heading', { name: 'Vorgeschlagene Entscheidungen' })).toBeVisible();
    await expect(app.decisions.locators.proposed.cards).toHaveCount(1);
    await expectNoSeriousA11yViolations(page, testInfo);

    await app.decisions.do.confirmProposed(DECISION);
    await app.navigation.do.open('decisions');
    await expect(app.decisions.row('Fassade streichen')).toBeVisible();
  });

  test('close their notification once every proposal is decided', async ({ on, page }) => {
    const app = on(page);
    await app.navigation.do.open('decisions');
    await app.decisions.locators.proposed.open.click();
    await app.decisions.do.confirmProposed(DECISION);

    await app.notifications.do.open();

    await expect(app.notifications.item(NOTIFICATION)).toHaveCount(0);
  });

  test('keep their proposals reachable after the notification is dismissed', async ({ on, page }) => {
    const app = on(page);
    await app.notifications.do.open();
    await app.notifications.locators.actions.dismiss.first().click();
    await expect(app.notifications.item(NOTIFICATION)).toHaveCount(0);
    await app.notifications.do.close();

    await app.navigation.do.open('decisions');
    await app.decisions.locators.proposed.open.click();

    await expect(app.decisions.locators.proposed.cards).toHaveCount(1);
  });

  test('can be confirmed from the notification as before', async ({ on, page }) => {
    const app = on(page);
    await app.notifications.do.open();

    await app.notifications.locators.actions.confirm.first().click();

    await expect(app.notifications.locators.actionDialog).toBeVisible();
    await expect(app.notifications.locators.actionDialog).toContainText(DECISION);
  });
});
