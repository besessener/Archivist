import type { ToolDeps } from './common';

/** Undo of folders the agent created: the newly added levels go again, as long as nothing was filed in them. */
export const FOLDER_CREATE_UNDO = 'agent_folder_create';
/** Undo of a scan exclusion set or lifted by the agent. */
export const SCAN_EXCLUSION_UNDO = 'agent_scan_exclusion';
/** Undo of a reminder the agent moved to another date. */
export const REMINDER_SNOOZE_UNDO = 'agent_reminder_snooze';

export interface ReminderSnoozeUndoData {
  id: string;
  before: { remindAt: string; status: string };
  after: { remindAt: string };
}

export interface FolderCreateUndoData {
  paths: string[];
}

export interface ScanExclusionUndoData {
  kind: 'file' | 'dir';
  path: string;
  /** true: the agent set the exclusion (undo lifts it); false: it lifted one (undo sets it again). */
  excluded: boolean;
}

const usedFolders = (deps: Pick<ToolDeps, 'docs'>) =>
  new Set(
    deps.docs
      .list({ limit: 50_000 })
      .flatMap((d) => (d.archiveRelPath ? [d.archiveRelPath.split('/').slice(0, -1).join('/')] : []))
      .map((f) => f.toLowerCase()),
  );

/** Undo handlers for agent tools whose service functions write no undo data of their own (#299, #304). */
export function registerToolUndo(deps: Pick<ToolDeps, 'undo' | 'categories' | 'scanner' | 'privacy' | 'docs' | 'reminders'>): void {
  deps.undo.register(FOLDER_CREATE_UNDO, {
    check: async (data) => {
      const used = usedFolders(deps);
      const busy = (data as FolderCreateUndoData).paths.filter((p) => [...used].some((u) => u === p.toLowerCase() || u.startsWith(`${p.toLowerCase()}/`)));
      return busy.length ? [`Im Ordner ${busy[0]} liegen inzwischen Dokumente.`] : [];
    },
    run: async (data) => {
      const { paths } = data as FolderCreateUndoData;
      for (const p of paths.toSorted((a, b) => b.length - a.length)) deps.categories.remove(p);
      return `${paths.length} Ordner entfernt.`;
    },
  });
  deps.undo.register(SCAN_EXCLUSION_UNDO, {
    check: async () => [],
    run: async (data) => {
      const d = data as ScanExclusionUndoData;
      if (!d.excluded) {
        deps.scanner.exclude(d.kind, d.path);
        return `${d.path} ist wieder vom Scan ausgeschlossen.`;
      }
      const ex = deps.scanner.listExclusions().find((e) => deps.privacy.paths.same(e.path, d.path));
      if (ex) deps.scanner.removeExclusion(ex.id);
      return `Ausschluss für ${d.path} aufgehoben.`;
    },
  });
  deps.undo.register(REMINDER_SNOOZE_UNDO, {
    check: async (data) => {
      const d = data as ReminderSnoozeUndoData;
      return deps.reminders.get(d.id).remindAt === d.after.remindAt ? [] : ['Die Erinnerung wurde seither erneut verschoben.'];
    },
    run: async (data) => {
      const d = data as ReminderSnoozeUndoData;
      deps.reminders.snooze(d.id, d.before.remindAt);
      if (d.before.status === 'dismissed') deps.reminders.dismiss(d.id);
      return 'Erinnerung auf den alten Termin zurückgesetzt.';
    },
  });
}
