import type { UpdateStatus } from '@archivist/shared';

// App updates from GitHub Releases; free of Electron so it can be unit-tested (the real `autoUpdater` is injected).

export interface UpdateInfoLike {
  version: string;
}

/** The part of electron-updater's `AppUpdater` that is used here. */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<{ updateInfo: UpdateInfoLike } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void;
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown;
}

export interface UpdateControllerDeps {
  updater: UpdaterLike;
  currentVersion: string;
  /** German reason why this build cannot update itself (development, portable version …), or null. */
  unsupportedReason: string | null;
  onChange(status: UpdateStatus): void;
  /** Closes the application cleanly, then runs the installer. */
  prepareInstall(): Promise<void>;
}

const CHECK_FAILED = 'Die Suche nach Updates ist fehlgeschlagen. Prüfe deine Internetverbindung und versuche es später erneut.';
const DOWNLOAD_FAILED = 'Das Update konnte nicht heruntergeladen werden. Versuche es später erneut.';

export class UpdateController {
  private current: UpdateStatus;

  constructor(private readonly deps: UpdateControllerDeps) {
    this.current = deps.unsupportedReason === null ? { state: 'idle' } : { state: 'unsupported', reason: deps.unsupportedReason };
    deps.updater.autoDownload = false; // the user confirms every download
    deps.updater.autoInstallOnAppQuit = false; // …and every installation
    deps.updater.on('download-progress', ({ percent }) => {
      if (this.current.state === 'downloading') this.set({ ...this.current, percent: Math.round(percent) });
    });
  }

  status(): UpdateStatus {
    return this.current;
  }

  async check(): Promise<UpdateStatus> {
    if (this.current.state === 'unsupported' || this.current.state === 'checking' || this.current.state === 'downloading') return this.current;
    this.set({ state: 'checking' });
    try {
      const result = await this.deps.updater.checkForUpdates();
      const version = result?.updateInfo.version;
      this.set(version && version !== this.deps.currentVersion ? { state: 'available', version } : { state: 'upToDate' });
    } catch {
      this.set({ state: 'error', message: CHECK_FAILED });
    }
    return this.current;
  }

  async download(): Promise<UpdateStatus> {
    if (this.current.state !== 'available') return this.current;
    const { version } = this.current;
    this.set({ state: 'downloading', version, percent: 0 });
    try {
      await this.deps.updater.downloadUpdate();
      this.set({ state: 'downloaded', version });
    } catch {
      this.set({ state: 'error', message: DOWNLOAD_FAILED });
    }
    return this.current;
  }

  /** Installs a downloaded update: shuts the application down cleanly first, then hands over to the installer. */
  async install(): Promise<void> {
    if (this.current.state !== 'downloaded') return;
    await this.deps.prepareInstall();
    this.deps.updater.quitAndInstall(true, true);
  }

  private set(next: UpdateStatus): void {
    this.current = next;
    this.deps.onChange(next);
  }
}

/** Why this build cannot update itself; null when it can (installed Windows version). */
export function unsupportedUpdateReason(env: { packaged: boolean; platform: string; portable: boolean }): string | null {
  if (!env.packaged) return 'In der Entwicklungsversion gibt es keine Updates.';
  if (env.platform !== 'win32') return 'Updates gibt es nur für Windows.';
  if (env.portable) return 'In der portablen Version sind Updates nicht möglich. Lade die neue Version von GitHub herunter.';
  return null;
}
