import { expect, type Page } from '@playwright/test';
import { pageObject } from './page-object';

type PrivacyMode = 'auto' | 'confirm' | 'local_only';

/** Settings page: the "Datenschutz" area, the archive root in the "Archiv" area and the reminder time in "Benachrichtigungen". */
export function initSettings(page: Page) {
  const dialog = page.getByTestId('archive-root-dialog');
  const locators = {
    tabs: {
      privacy: page.getByTestId('tab-privacy'),
      archive: page.getByTestId('tab-archive'),
      notifications: page.getByTestId('tab-notifications'),
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
    trash: {
      items: page.getByTestId('trash-item'),
      restore: page.getByTestId('trash-restore'),
      empty: page.getByTestId('trash-empty'),
      confirmCheckbox: page.getByTestId('confirm-dialog-checkbox'),
      confirmEmpty: page.getByTestId('trash-empty-confirm'),
    },
    notifications: {
      reminderTime: page.getByTestId('settings-reminder-time'),
      saveReminderTime: page.getByTestId('settings-reminder-time-save'),
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
    /** Empties the trash: needs the second confirmation (checkbox) in the dialog. */
    emptyTrash: async () => {
      await locators.trash.empty.click();
      await expect(locators.trash.confirmEmpty).toBeDisabled();
      await locators.trash.confirmCheckbox.click();
      await locators.trash.confirmEmpty.click();
      await expect(locators.trash.items).toHaveCount(0);
    },
    openNotifications: async () => {
      await locators.tabs.notifications.click();
    },
    setReminderTime: async (time: string) => {
      await locators.notifications.reminderTime.fill(time);
      await locators.notifications.saveReminderTime.click();
      await expect(locators.notifications.saveReminderTime).toBeDisabled();
    },
  };
  return pageObject({ root: page.getByRole('tablist', { name: 'Einstellungsbereiche' }), locators, actions: interactions });
}
