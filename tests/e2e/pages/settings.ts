import { expect, type Page } from '@playwright/test';
import { pageObject } from './page-object';

type PrivacyMode = 'auto' | 'confirm' | 'local_only';

/** Settings page: the "Datenschutz" area, the archive root in the "Archiv" area and the reminder time in "Benachrichtigungen". */
export function initSettings(page: Page) {
  const dialog = page.getByTestId('archive-root-dialog');
  const locators = {
    tabs: {
      llm: page.getByTestId('tab-llm'),
      privacy: page.getByTestId('tab-privacy'),
      agent: page.getByTestId('tab-agent'),
      archive: page.getByTestId('tab-archive'),
      notifications: page.getByTestId('tab-notifications'),
      backups: page.getByTestId('tab-backups'),
      audit: page.getByTestId('tab-audit'),
    },
    audit: {
      rows: page.getByTestId('audit-row'),
      row: (text: string) => page.getByTestId('audit-row').filter({ hasText: text }),
      more: page.getByTestId('audit-more'),
      chainOk: page.getByTestId('audit-chain-ok'),
      chainBroken: page.getByTestId('audit-chain-broken'),
      undo: page.getByTestId('audit-undo'),
      confirmUndo: page.getByTestId('audit-undo-confirm'),
    },
    llm: {
      baseUrl: page.getByTestId('settings-baseurl'),
      baseUrlError: page.getByTestId('s-baseurl-error'),
      save: page.getByTestId('settings-save'),
      testConnection: page.getByTestId('settings-test-connection'),
      testResult: page.getByTestId('settings-test-result'),
      effort: page.getByTestId('settings-effort'),
    },
    privacy: {
      mode: (mode: PrivacyMode) => page.getByTestId(`settings-mode-${mode}`),
      activeMode: page.getByTestId('privacy-mode-active'),
      extensions: page.getByTestId('privacy-exts'),
      usageToday: page.getByTestId('usage-today'),
      usageMonth: page.getByTestId('usage-month'),
      capInput: page.getByTestId('usage-cap'),
      capError: page.getByTestId('usage-cap-error'),
      capSave: page.getByTestId('usage-cap-save'),
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
    agent: {
      settingsTab: page.getByTestId('agent-tab-settings'),
      memoryTab: page.getByTestId('agent-tab-memory'),
      nightlyHour: page.getByLabel('Nachtlauf (Archivprüfung, Verknüpfungen und geplante Abläufe)'),
      kindLimits: page.getByTestId('agent-kind-limits'),
      /** Field of one background trigger's own limits, e.g. („Archivprüfung auswerten“, „Tokens“). */
      kindLimit: (trigger: string, field: 'Runden' | 'Tokens' | 'Minuten') =>
        page.getByTestId('agent-kind-limits').getByRole('group', { name: trigger }).getByLabel(field),
      save: page.getByTestId('agent-settings-save'),
      validation: page.getByTestId('agent-settings-error'),
    },
    memory: {
      newEntry: page.getByTestId('memory-new'),
      entries: page.getByTestId('memory-entry'),
      entry: (name: string) => page.getByTestId('memory-entry').filter({ hasText: name }),
      use: (name: string) => page.getByRole('switch', { name: `${name} verwenden` }),
      edit: (name: string) => page.getByRole('button', { name: `${name} bearbeiten` }),
      remove: (name: string) => page.getByRole('button', { name: `${name} löschen` }),
      exportButton: page.getByRole('button', { name: 'Exportieren' }),
      importInput: page.getByLabel('Gelernte Einträge importieren (JSON)'),
      confirmDelete: page.getByTestId('confirm-dialog-confirm'),
      dialog: {
        root: page.getByTestId('memory-dialog'),
        kind: page.getByTestId('memory-dialog').getByLabel('Art'),
        name: page.getByTestId('memory-name'),
        content: page.getByTestId('memory-content'),
        field: (label: string) => page.getByTestId('memory-dialog').getByLabel(label),
        weekday: page.getByTestId('memory-dialog').getByLabel('Automatisch ausführen'),
        nightlyOff: page.getByTestId('memory-workflow-nightly-off'),
        error: page.getByTestId('memory-data-error'),
        save: page.getByTestId('memory-save'),
      },
    },
    archiveCheck: {
      verify: page.getByTestId('archive-verify'),
      report: page.getByTestId('verify-report'),
      relink: page.getByTestId('archive-relink'),
      confirmRelink: page.getByTestId('archive-relink-confirm'),
      relinkResult: page.getByTestId('archive-relink-result'),
    },
    backups: {
      createMetadata: page.getByTestId('backup-metadata'),
      rows: page.getByTestId('backup-row'),
      restore: page.getByTestId('backup-restore'),
      confirmRestore: page.getByTestId('backup-restore-confirm'),
      restartNotice: page.getByTestId('backup-restart-notice'),
    },
    notifications: {
      reminderTime: page.getByTestId('settings-reminder-time'),
      saveReminderTime: page.getByTestId('settings-reminder-time-save'),
    },
  };
  const interactions = {
    openLlm: async () => {
      await locators.tabs.llm.click();
    },
    openPrivacy: async () => {
      await locators.tabs.privacy.click();
    },
    openAudit: async () => {
      await locators.tabs.audit.click();
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
    openAgent: async () => {
      await locators.tabs.agent.click();
    },
    openLearned: async () => {
      await locators.tabs.agent.click();
      await locators.agent.memoryTab.click();
    },
    /** Creates a rule through the form fields of the dialog. */
    addRule: async (rule: { name: string; content: string; when: Record<string, string>; then: Record<string, string> }) => {
      const { dialog } = locators.memory;
      await locators.memory.newEntry.click();
      await dialog.kind.selectOption('rule');
      await dialog.name.fill(rule.name);
      await dialog.content.fill(rule.content);
      for (const [label, value] of Object.entries({ ...rule.when, ...rule.then })) await dialog.field(label).fill(value);
      await dialog.save.click();
      await dialog.root.waitFor({ state: 'hidden' });
    },
    /** Clicks „Exportieren“ and returns the JSON text of the export file (Electron gives the page no download event). */
    exportLearned: async () => {
      await page.evaluate(() => {
        const exported: Blob[] = [];
        const create = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (blob: Blob | MediaSource) => {
          exported.push(blob as Blob);
          return create(blob);
        };
        Object.assign(window, { exportedBlobs: exported });
      });
      await locators.memory.exportButton.click();
      return page.evaluate(() => (window as unknown as { exportedBlobs: Blob[] }).exportedBlobs.at(-1)!.text());
    },
    openBackups: async () => {
      await locators.tabs.backups.click();
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
