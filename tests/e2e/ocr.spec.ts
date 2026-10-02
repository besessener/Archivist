import { expect, test } from './fixture';
import { writeTextImage } from './helpers';

test.describe('text recognition (OCR)', () => {
  test('recognises text in an image locally and passes it on to the analysis', async ({ llm, on, page, workspace }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    // deliberately outside the scan folder
    const scan = await writeTextImage({ dir: workspace.dataDir, name: 'scan.png', lines: ['Rechnung 4711', 'Zahlungsziel 30 Tage'] });

    await app.inbox.do.importFile(scan);

    await expect.poll(() => llm.calls.some((call) => call.schema === 'DocumentClassification' && call.input.includes('4711')), { timeout: 90_000 }).toBe(true);
  });
});
