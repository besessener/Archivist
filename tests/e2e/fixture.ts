/* eslint-disable no-empty-pattern -- Playwright requires destructuring as the first argument of a fixture */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, test as base, type ElectronApplication, type Page } from '@playwright/test';
import { startFakeLlm, type FakeLlmServer } from './fake-llm';
import { createPageTree, type PageTree } from './pages';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- the electron package exports the binary path, which its typings (the Electron API) do not describe
const electronPath = require('electron') as unknown as string;
const appDir = path.resolve(__dirname, '../../apps/desktop');

/** Fresh, isolated working directory per test: the app's data folder and a "Downloads" folder that serves as scan target. */
export interface Workspace {
  dataDir: string;
  downloads: string;
  /** Writes a file into the Downloads folder and returns its path. */
  addDownload(name: string, content: string): string;
}

interface Options {
  /** Folder name the data directory is placed in (e.g. "OneDrive" to run inside a cloud-synced folder). */
  dataParent: string;
}

interface Fixtures {
  llm: FakeLlmServer;
  workspace: Workspace;
  electronApp: ElectronApplication;
  page: Page;
  /** Page objects for a page; a function of `page` so that a spec can also address a second window. */
  on: (page: Page) => PageTree;
}

async function launch(env: Record<string, string>): Promise<ElectronApplication> {
  // Launching occasionally hangs on CI runners (Chromium/D-Bus/Xvfb race); up to two restarts fix that without skipping test content.
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await electron.launch({
        executablePath: electronPath,
        args: [appDir, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
        timeout: 45_000,
        env,
      });
    } catch (error) {
      if (attempt >= 3) throw error;
    }
  }
}

export const test = base.extend<Fixtures & Options>({
  dataParent: ['', { option: true }],

  llm: async ({}, provide) => {
    const llm = await startFakeLlm();
    await provide(llm);
    await llm.close();
  },

  workspace: async ({ dataParent }, provide) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-e2e-'));
    const downloads = path.join(root, 'Downloads');
    fs.mkdirSync(downloads, { recursive: true });
    await provide({
      dataDir: path.join(root, dataParent, 'Archivist'),
      downloads,
      addDownload: (name, content) => {
        const file = path.join(downloads, name);
        fs.writeFileSync(file, content);
        return file;
      },
    });
    fs.rmSync(root, { recursive: true, force: true });
  },

  electronApp: async ({ workspace }, provide) => {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ELECTRON_ENABLE_LOGGING: '1',
      ARCHIVIST_DATA_DIR: workspace.dataDir,
      ARCHIVIST_TEST_MODE: '1',
      ARCHIVIST_TEST_PICK_DIR: workspace.downloads,
    };
    delete env.DBUS_SESSION_BUS_ADDRESS; // an invalid bus only causes error messages from Chromium
    const app = await launch(env);
    await provide(app);
    await app.close();
  },

  // Overrides the browser fixture `page`: the window of the Electron application.
  page: async ({ electronApp }, provide, testInfo) => {
    const page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await provide(page);
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('window-after-failure', { body: await page.screenshot(), contentType: 'image/png' });
    }
  },

  on: async ({}, provide) => {
    await provide((page) => createPageTree(page));
  },
});

export { expect } from '@playwright/test';
