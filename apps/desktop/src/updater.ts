import type { UpdateStatus } from '@archivist/shared';
import { updateFailureMessage } from './update-messages';

// App updates from GitHub Releases; free of Electron so it can be unit-tested (the real `autoUpdater` is injected).

export interface UpdateInfoLike {
  version: string;
}

/** The part of electron-updater's `AppUpdater` that is used here. */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  /** `isUpdateAvailable` is false for an older or the same release, and for one this installation may not take yet. */
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: UpdateInfoLike } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void;
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown;
}

export interface UpdateControllerDeps {
  updater: UpdaterLike;
  /** `idle`, or `unsupported` with the reason (see `initialUpdateStatus`). */
  initialStatus: UpdateStatus;
  onChange(status: UpdateStatus): void;
  /** Quits through the bounded quit path (database closed, deadline) and calls `startInstaller` right before the process exits. */
  quit(startInstaller: () => void): Promise<void>;
  /** Records the real cause of a failure in Archivist's log; the user reads a German message instead. */
  log(message: string, error: unknown): void;
}

/** A new check would discard what is under way or ready: a check, a download, a downloaded installer, the installation. */
const CHECK_BLOCKING_STATES: readonly UpdateStatus['state'][] = ['unsupported', 'checking', 'downloading', 'downloaded', 'installing'];

const INSTALL_SILENTLY = true;
const START_AFTER_INSTALL = true;

export class UpdateController {
  private current: UpdateStatus;

  constructor(private readonly deps: UpdateControllerDeps) {
    this.current = deps.initialStatus;
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
    if (CHECK_BLOCKING_STATES.includes(this.current.state)) return this.current;
    this.set({ state: 'checking' });
    try {
      const result = await this.deps.updater.checkForUpdates();
      this.set(result?.isUpdateAvailable ? { state: 'available', version: result.updateInfo.version } : { state: 'upToDate' });
    } catch (error) {
      this.deps.log('Update check failed', error);
      this.set({ state: 'error', message: updateFailureMessage('check', error) });
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
    } catch (error) {
      this.deps.log('Update download failed', error);
      this.set({ state: 'error', message: updateFailureMessage('download', error) });
    }
    return this.current;
  }

  /** Installs a downloaded update: quits Archivist cleanly, then hands over to the installer. */
  async install(): Promise<void> {
    if (this.current.state !== 'downloaded') return;
    this.set({ state: 'installing', version: this.current.version });
    try {
      await this.deps.quit(() => this.deps.updater.quitAndInstall(INSTALL_SILENTLY, START_AFTER_INSTALL));
    } catch (error) {
      this.deps.log('Update installation failed', error);
      this.set({ state: 'error', message: updateFailureMessage('install', error) });
    }
  }

  private set(next: UpdateStatus): void {
    this.current = next;
    this.deps.onChange(next);
  }
}

/** `idle` for the installed Windows version; otherwise `unsupported` with the reason this build cannot update itself. */
export function initialUpdateStatus(env: { packaged: boolean; platform: string; portable: boolean }): UpdateStatus {
  if (!env.packaged) return { state: 'unsupported', reason: 'In der Entwicklungsversion gibt es keine Updates.' };
  if (env.platform !== 'win32') return { state: 'unsupported', reason: 'Updates gibt es nur für Windows.' };
  if (env.portable) return { state: 'unsupported', reason: 'In der portablen Version sind Updates nicht möglich. Lade die neue Version von GitHub herunter.' };
  return { state: 'idle' };
}

export interface UpdateHostOptions extends Omit<UpdateControllerDeps, 'initialStatus'> {
  /** How this build runs; decides whether it can update itself. */
  build: { packaged: boolean; platform: string; portable: boolean };
  /** E2E (`ARCHIVIST_TEST_UPDATE_VERSION`): a stand-in offers this version, and installing quits nothing (the test keeps the app). */
  testVersion?: string;
}

/** The update controller of the main process, with the E2E stand-in in place of electron-updater when a test asks for it. */
export function createUpdateHost({ build, testVersion, ...deps }: UpdateHostOptions): UpdateController {
  if (!testVersion) return new UpdateController({ ...deps, initialStatus: initialUpdateStatus(build) });
  return new UpdateController({ ...deps, updater: fakeUpdater(testVersion), initialStatus: { state: 'idle' }, quit: async () => undefined });
}

/** E2E stand-in for electron-updater: always offers `version`, downloads at once; installing is left to the test. */
export function fakeUpdater(version: string): UpdaterLike {
  const progressListeners: ((progress: { percent: number }) => void)[] = [];
  return {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version } }),
    downloadUpdate: async () => {
      for (const listener of progressListeners) listener({ percent: 50 });
    },
    quitAndInstall: () => undefined,
    on: (_event, listener) => progressListeners.push(listener),
  };
}
