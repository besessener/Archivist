import { expectNoSeriousA11yViolations } from './axe';
import { expect, test as base } from './fixture';
import { seedLongLists } from './helpers';

/** One open finding („Hinweis 1“) before the first start. */
const test = base.extend({
  workspace: async ({ workspace }, provide) => {
    seedLongLists(workspace.dataDir, 1);
    await provide(workspace);
  },
});

test('Insights shows the findings first and the link proposals below; the navigation counts both apart', async ({ llm, on, page }, testInfo) => {
  const app = on(page);
  await app.setup.do.complete(llm.url);
  await app.navigation.do.open('knowledge');
  const k = app.knowledge;
  await k.do.create({
    type: 'note',
    name: 'Heizung Wartung',
    description: 'Die Heizung im Keller wurde von der Firma Kalt gewartet, der Brenner der Heizung wurde gereinigt.',
  });
  await k.do.create({ type: 'note', name: 'Heizung Brenner', description: 'Die Firma Kalt hat am Brenner der Heizung im Keller einen Defekt gefunden.' });
  await expect(page.getByTestId('related-entry').filter({ hasText: 'Heizung Wartung' })).toBeVisible();

  const nav = app.navigation.locators;
  await expect(nav.count('insights')).toHaveAccessibleName('offene Hinweise: 1');
  await expect(nav.insightLinksCount).toHaveAccessibleName('offene Verknüpfungsvorschläge: 1');

  await app.navigation.do.open('insights');
  const finding = app.insights.card('Hinweis 1');
  const proposals = page.getByTestId('link-proposals');
  await expect(finding).toBeVisible();
  await expect(proposals).toBeVisible();
  expect((await finding.boundingBox())!.y).toBeLessThan((await proposals.boundingBox())!.y);
  await expectNoSeriousA11yViolations(page, testInfo);

  await proposals.getByTestId('link-proposal-confirm').first().click();
  await expect(nav.insightLinksCount).toBeHidden();
});
