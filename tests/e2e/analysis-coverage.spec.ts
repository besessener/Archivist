import { expectNoSeriousA11yViolations } from './axe';
import { expect, test } from './fixture';

const PARAGRAPH = 'Dieser Absatz beschreibt den Ablauf der Sitzung ohne jede Festlegung und füllt nur Platz.\n';

test.describe('coverage of long documents', () => {
  test.beforeEach(async ({ llm, on, page }) => {
    await on(page).setup.do.complete(llm.url);
  });

  test('tells how much of a long document was read and that the extraction stopped at its limit', async ({ on, page, workspace }, testInfo) => {
    const app = on(page);
    const file = workspace.addDownload('langes-protokoll.txt', `Jour Fixe Nordlicht\n${PARAGRAPH.repeat(5000)}`);

    await app.inbox.do.importFile(file);
    await app.navigation.do.open('inbox');
    await app.inbox.do.waitForProposal('Arbeit/Projekte/Nordlicht');

    await expect(app.inbox.locators.coverage).toContainText('länger als die Grenze beim Einlesen');
    await expect(app.inbox.locators.coverage).toContainText('Die KI hat nur die ersten');
    await expectNoSeriousA11yViolations(page, testInfo);
  });

  test('says nothing about coverage for a short document', async ({ on, page, workspace }) => {
    const app = on(page);

    await app.inbox.do.importFile(workspace.addDownload('jour-fixe.txt', 'Jour Fixe Nordlicht am 04.05.2026.'));
    await app.navigation.do.open('inbox');
    await app.inbox.do.waitForProposal('Arbeit/Projekte/Nordlicht');

    await expect(app.inbox.locators.coverage).toHaveCount(0);
  });
});
