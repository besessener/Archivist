/* eslint-disable no-empty-pattern -- Playwright verlangt ein Destructuring als erstes Argument einer Fixture */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, test as base, type ElectronApplication, type Page } from '@playwright/test';
import { startFakeLlm, type FakeLlmServer } from './fake-llm';
import { createPageTree, type PageTree } from './pages';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;
const appDir = path.resolve(__dirname, '../../apps/desktop');
// ARCHIVIST_E2E_PACKAGED=1: die gepackte Anwendung (electron-builder --dir) statt des Entwicklungsaufbaus testen
const packaged = process.env.ARCHIVIST_E2E_PACKAGED === '1';
const packagedBinary = path.join(appDir, 'release', 'linux-unpacked', 'archivist');

/** Frisches, isoliertes Arbeitsverzeichnis pro Test: Datenordner der App und ein „Downloads“-Ordner, der als Scan-Ziel dient. */
export interface Workspace {
  dataDir: string;
  downloads: string;
  /** Schreibt eine Datei in den Downloads-Ordner und gibt ihren Pfad zurück. */
  addDownload(name: string, content: string): string;
}

interface Fixtures {
  llm: FakeLlmServer;
  workspace: Workspace;
  electronApp: ElectronApplication;
  page: Page;
  /** Page Objects für eine Seite; als Funktion von `page`, damit ein Spec auch ein zweites Fenster ansprechen kann. */
  on: (page: Page) => PageTree;
}

async function launch(env: Record<string, string>): Promise<ElectronApplication> {
  // Der Start der Electron-Binärdatei hängt auf CI-Runnern gelegentlich (Chromium/D-Bus/Xvfb-Race) – ein Neustart behebt das,
  // ohne dass Testinhalte übersprungen werden. Es wird höchstens zweimal wiederholt.
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await electron.launch({
        executablePath: packaged ? packagedBinary : electronPath,
        args: [...(packaged ? [] : [appDir]), '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
        timeout: 45_000,
        env,
      });
    } catch (err) {
      if (attempt >= 3) throw err;
    }
  }
}

export const test = base.extend<Fixtures>({
  llm: async ({}, provide) => {
    const llm = await startFakeLlm();
    await provide(llm);
    await llm.close();
  },

  workspace: async ({}, provide) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-e2e-'));
    const downloads = path.join(root, 'Downloads');
    fs.mkdirSync(downloads, { recursive: true });
    await provide({
      dataDir: path.join(root, 'Archivist'),
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
    delete env.DBUS_SESSION_BUS_ADDRESS; // ein ungültiger Bus verursacht nur Fehlermeldungen von Chromium
    const app = await launch(env);
    await provide(app);
    await app.close();
  },

  // Überschreibt die Browser-Fixture `page`: das Fenster der Electron-Anwendung.
  page: async ({ electronApp }, provide, testInfo) => {
    const page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await provide(page);
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('fenster-nach-fehler', { body: await page.screenshot(), contentType: 'image/png' });
    }
  },

  on: async ({}, provide) => {
    await provide((page) => createPageTree(page));
  },
});

export { expect } from '@playwright/test';
