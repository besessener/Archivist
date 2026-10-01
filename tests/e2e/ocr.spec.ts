import { expect, test } from './fixture';
import { writeTextImage } from './helpers';

test.describe('Texterkennung (OCR)', () => {
  test('erkennt Text in einem Bild lokal und gibt ihn an die Analyse weiter', async ({ llm, on, page, workspace }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    // bewusst außerhalb des Scan-Ordners
    const scan = await writeTextImage(workspace.dataDir, 'scan.png', ['Rechnung 4711', 'Zahlungsziel 30 Tage']);

    await app.inbox.do.importFile(scan);

    await expect.poll(() => llm.calls.some((call) => call.schema === 'DocumentClassification' && call.input.includes('4711')), { timeout: 90_000 }).toBe(true);
  });
});
