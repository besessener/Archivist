import type { Page } from '@playwright/test';
import { pageObject } from './page-object';

type PrivacyMode = 'auto' | 'confirm' | 'local_only';

/** Settings page: the "Datenschutz" area and the archive root in the "Archiv" area. */
export function initSettings(page: Page) {
  const dialog = page.getByTestId('archive-root-dialog');
  const locators = {
    tabs: {
      privacy: page.getByTestId('tab-privacy'),
      archive: page.getByTestId('tab-archive'),
    },
    privacy: {
      mode: (mode: PrivacyMode) => page.getByTestId(`settings-mode-${mode}`),
      activeMode: page.getByTestId('privacy-mode-active'),
      extensions: page.getByTestId('privacy-exts'),
    },
    archiveRoot: {
      input: page.getByTestId('settings-archive-root'),
      change: page.getByTestId('settings-archive-change'),
      unreachable: page.getByTestId('archive-root-unreachable'),
      lastChange: page.getByTestId('archive-root-last-change'),
      undo: page.getByTestId('archive-root-undo'),
      dialog: {
        root: dialog,
        migrate: dialog.getByTestId('archive-root-migrate'),
        pathOnly: dialog.getByTestId('archive-root-path-only'),
        pathWarning: dialog.getByTestId('archive-root-path-warning'),
        accept: dialog.getByTestId('archive-root-accept'),
        cancel: dialog.getByTestId('archive-root-cancel'),
      },
    },
  };
  const interactions = {
    openPrivacy: async () => {
      await locators.tabs.privacy.click();
    },
    openArchive: async () => {
      await locators.tabs.archive.click();
    },
    selectMode: async (mode: PrivacyMode) => {
      await locators.privacy.mode(mode).check();
    },
    /** Enters a new archive root and opens the dialog with the ways to change it. */
    startArchiveRootChange: async (root: string) => {
      await locators.archiveRoot.input.fill(root);
      await locators.archiveRoot.change.click();
      await locators.archiveRoot.dialog.root.waitFor();
    },
  };
  return pageObject(page.getByRole('tablist', { name: 'Einstellungsbereiche' }), locators, interactions);
}
