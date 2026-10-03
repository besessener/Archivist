import { seedArchivedDocuments } from './helpers';
import { expect, test as base } from './fixture';

/** 105 archived documents: the five oldest are contracts, all newer ones invoices. */
const test = base.extend({
  workspace: async ({ workspace }, provide) => {
    seedArchivedDocuments(workspace.dataDir, [...Array<string>(5).fill('Vertrag'), ...Array<string>(100).fill('Rechnung')]);
    await provide(workspace);
  },
});

test.describe('document list of a large archive', () => {
  test.beforeEach(async ({ llm, on, page }) => {
    await on(page).setup.do.complete(llm.url);
  });

  test('shows the newest 100 with „N von M“ and loads the rest with „Mehr laden“ (#222)', async ({ on, page }) => {
    const app = on(page);
    await app.navigation.do.open('documents');
    const documents = app.documents.locators;

    await expect(documents.rows).toHaveCount(100);
    await expect(documents.capped).toContainText('Angezeigt werden die neuesten 100 von 105 Dokumenten.');
    await expect(documents.capped).toContainText('Der Typfilter wirkt nur auf die geladenen Dokumente.');
    await expect(documents.typeFilter.getByRole('option', { name: 'Vertrag' })).toHaveCount(0);

    await documents.loadMore.click();

    await expect(documents.rows).toHaveCount(105);
    await expect(documents.capped).toBeHidden();
    await documents.typeFilter.selectOption('Vertrag');
    await expect(documents.rows).toHaveCount(5);
  });
});
