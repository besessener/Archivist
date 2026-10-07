import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixture';

function savedMinConfidence(dataDir: string): number {
  const settings = JSON.parse(fs.readFileSync(path.join(dataDir, 'config', 'settings.json'), 'utf8')) as { links: { minConfidence: number } };
  return settings.links.minConfidence;
}

test.describe('minimum confidence of link proposals', () => {
  test('the slider is saved and keeps its value (#269)', async ({ llm, on, page, workspace }) => {
    const app = on(page);
    await app.setup.do.complete(llm.url);
    await app.navigation.do.open('settings');
    await app.settings.do.openAgent();
    await app.settings.locators.agent.runsTab.click();
    await expect(app.settings.locators.links.minConfidence).toHaveValue('0');

    await app.settings.do.setMinConfidenceSteps(12);

    await expect.poll(() => savedMinConfidence(workspace.dataDir)).toBe(0.6);
    await expect(app.settings.locators.links.minConfidence).toHaveValue('60');
  });
});
