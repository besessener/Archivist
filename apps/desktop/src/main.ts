import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, protocol, safeStorage, session, shell, type IpcMainInvokeEvent } from 'electron';
import {
  AppError,
  createHandlers,
  createIpcDispatcher,
  createServices,
  resolveDataPaths,
  newestIntactSource,
  scheduleRestore,
  type HostApi,
  type SecretCipher,
  type Services,
  type SpeechModelSpec,
} from '@archivist/core';
import { IPC_CHANNELS, type AppNotification, type SpeechModelName } from '@archivist/shared';
import { appUserModelId } from './app-id';
import { readUnpackagedEnv } from './test-environment';
import { JOB_INTERRUPT_TIMEOUT_MS, QuitController } from './lifecycle';
import { isExternalWebUrl } from './external-links';
import { allowsMicrophoneCheck, allowsMicrophoneRequest } from './permissions';
import { recoverFromDamagedDatabase, type RecoveryDeps } from './recovery';
import { APP_ORIGIN, serveRenderer } from './renderer-server';

// Electron main process: lifecycle, secure windows, IPC allowlist and OS access; the business logic lives in @archivist/core.
const unpackagedEnv = (name: string) => readUnpackagedEnv({ packaged: app.isPackaged, env: process.env }, name);
const devUrl = unpackagedEnv('ARCHIVIST_DEV_URL');
const isDev = Boolean(devUrl);
const testMode = unpackagedEnv('ARCHIVIST_TEST_MODE') === '1';
const testSpeechModels = unpackagedEnv('ARCHIVIST_TEST_SPEECH_MODELS');

// the interface is German only: date and time fields follow Chromium's language, not the operating system's
app.commandLine.appendSwitch('lang', 'de-DE');
// E2E: a synthetic microphone and camera; the permission handlers below still decide who may use them
if (testMode) app.commandLine.appendSwitch('use-fake-device-for-media-stream');
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

if (process.env.ARCHIVIST_DATA_DIR) app.setPath('userData', path.join(process.env.ARCHIVIST_DATA_DIR, '.electron'));
// Windows shows desktop notifications only for a process whose AppUserModelID matches a Start menu shortcut
if (process.platform === 'win32') app.setAppUserModelId(appUserModelId({ packaged: app.isPackaged, execPath: process.execPath }));

let services: Services | null = null;
let mainWindow: BrowserWindow | null = null;

/** Quitting interrupts running jobs (they resume after the next start) and exits after a bounded time. */
const quitter = new QuitController({
  shutdown: () => services?.shutdown({ jobTimeoutMs: JOB_INTERRUPT_TIMEOUT_MS }) ?? Promise.resolve(),
  exit: (code) => app.exit(code),
  relaunch: () => app.relaunch(),
  log: (message, error) =>
    process.stderr.write(
      `[archivist] ${message}${error === undefined ? '' : `: ${error instanceof Error ? (error.stack ?? error.message) : JSON.stringify(error)}`}\n`,
    ),
});

const recoveryDeps = (): RecoveryDeps => ({
  paths: resolveDataPaths({ root: dataRoot(), appDataRoot: appDataRoot() }),
  findNewestRestore: newestIntactSource,
  scheduleRestore,
  askToRestore: ({ message }) =>
    dialog.showMessageBoxSync({
      type: 'error',
      title: 'Datenbank beschädigt',
      message: 'Die Datenbank von Archivist ist beschädigt.',
      detail: message,
      buttons: ['Backup wiederherstellen', 'Beenden'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }) === 0,
  showError: (title, message) => dialog.showErrorBox(title, message),
  relaunch: () => app.relaunch(),
  exit: (code) => app.exit(code),
});

const RESTART_DELAY_MS = 500;

// ARCHIVIST_DATA_DIR keeps everything below one folder; otherwise only documents stay in Documents, the application state goes to the per-user data folder
const dataRoot = () => process.env.ARCHIVIST_DATA_DIR ?? path.join(app.getPath('documents'), 'Archivist');
const appDataRoot = () => (process.env.ARCHIVIST_DATA_DIR ? undefined : app.getPath('userData'));
const resource = (...segments: string[]) => path.join(__dirname, ...segments);

/** Encryption via Electron safeStorage (Windows DPAPI; the Linux branches only serve development and CI). */
const cipher: SecretCipher = {
  isAvailable: () => {
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (process.platform === 'linux') {
      const backend = safeStorage.getSelectedStorageBackend();
      // "basic_text" only stores keys obfuscated – allowed only in explicit test mode
      return backend !== 'basic_text' && backend !== 'unknown' ? true : testMode;
    }
    return true;
  },
  backend: () => (process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'Windows DPAPI'),
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (data) => safeStorage.decryptString(data),
};

const host: HostApi = {
  version: app.getVersion(),
  platform: process.platform,
  selectDirectory: async (title) => {
    const options: Electron.OpenDialogOptions = { title: title ?? 'Verzeichnis auswählen', properties: ['openDirectory'] };
    const testPickDir = unpackagedEnv('ARCHIVIST_TEST_PICK_DIR');
    if (testPickDir) return testPickDir; // E2E: no native dialog
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled || result.filePaths.length === 0 ? null : (result.filePaths[0] ?? null);
  },
  openPath: (filePath) => shell.openPath(filePath),
  revealPath: (filePath) => shell.showItemInFolder(filePath),
  saveFile: async (defaultName) => {
    const options: Electron.SaveDialogOptions = { title: 'Speichern unter', defaultPath: path.join(app.getPath('documents'), defaultName) };
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
    return result.canceled || !result.filePath ? null : result.filePath;
  },
  restartApp: () => {
    if (testMode) return; // E2E: the test drives the application and must not lose it
    quitter.requestRelaunch();
    setTimeout(() => void quitter.quit(), RESTART_DELAY_MS); // the answer reaches the window first
  },
};

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  const trusted = url.startsWith(`${APP_ORIGIN}/`) || (isDev && url.startsWith(devUrl!));
  return trusted && mainWindow !== null && event.sender === mainWindow.webContents;
}

function registerIpc(appServices: Services): void {
  const dispatch = createIpcDispatcher(createHandlers(appServices, host), (channel, err) =>
    appServices.logger.error('ipc', `Error in ${channel}`, { error: err }),
  );
  for (const channel of IPC_CHANNELS) {
    ipcMain.handle(channel, async (event, input: unknown) => {
      if (!isTrustedSender(event)) {
        return { ok: false, error: { category: 'permission_error', message: 'Unbefugter Absender.', retryable: false } };
      }
      return dispatch(channel, input);
    });
  }
}

function forwardEvents(appServices: Services): void {
  const send = (channel: string, payload: unknown) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };
  let timer: NodeJS.Timeout | null = null;
  const scopes = new Set<string>();
  appServices.events.on('data:changed', (change: { scopes: string[] }) => {
    for (const scope of change.scopes) scopes.add(scope);
    timer ??= setTimeout(() => {
      send('data:changed', { scopes: [...scopes] });
      scopes.clear();
      timer = null;
    }, 60);
  });
  appServices.events.on('job:updated', (job) => send('job:updated', job));
  appServices.events.on('status:changed', () => send('status:changed', {}));
  // live steps of agent runs (#300); throttled in the agent service
  appServices.events.on('agent:progress', (progress: unknown) => send('agent:progress', progress));
  appServices.events.on('notification:new', (notification: AppNotification) => {
    send('notification:new', notification);
    if (appServices.settings.get().notifications.desktop && Notification.isSupported()) {
      const note = new Notification({ title: notification.title, body: notification.description.slice(0, 200), silent: notification.priority === 'low' });
      note.on('click', showMainWindow);
      note.show();
    }
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 980,
    minHeight: 620,
    show: false,
    title: 'Archivist',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: resource('preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: !app.isPackaged || isDev,
    },
  });
  // the window title stays short; the page <title> carries the subtitle
  mainWindow.on('page-title-updated', (event) => event.preventDefault());
  const contents = mainWindow.webContents;
  const allowed = (url: string) => url.startsWith(`${APP_ORIGIN}/`) || (isDev && url.startsWith(devUrl!));
  contents.on('will-navigate', (event, url) => {
    if (!allowed(url)) event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    if (!allowed(url)) event.preventDefault();
  });
  // links (e.g. sources of a web search) open in the system browser – never inside the app window
  contents.setWindowOpenHandler(({ url }) => {
    if (isExternalWebUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  void mainWindow.loadURL(isDev ? devUrl! : `${APP_ORIGIN}/chat/`);
}

/** Brings the main window to the front, or opens a new one if there is none (e.g. after it was closed). */
function showMainWindow(): void {
  if (quitter.quitting || !services) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: 'editMenu' },
    {
      label: 'Ansicht',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' },
        ...(isDev ? [{ role: 'toggleDevTools' as const }, { role: 'reload' as const }] : []),
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function start(): Promise<void> {
  // The insecure fallback is allowed only in explicit test mode (CI without a keyring).
  if (testMode && process.platform === 'linux') safeStorage.setUsePlainTextEncryption(true);
  const migrations = resource('migrations');
  services = createServices({
    dataRoot: dataRoot(),
    appDataRoot: appDataRoot(),
    migrationsFolder: migrations,
    cipher,
    appVersion: app.getVersion(),
    workerFile: resource('worker.cjs'),
    readerFile: resource('db-reader.cjs'),
    // E2E: a stand-in worker and a model served by the test (no real Whisper)
    speechWorkerFile: unpackagedEnv('ARCHIVIST_TEST_SPEECH_WORKER') ?? resource('speech-worker.cjs'),
    speech: testSpeechModels ? { models: JSON.parse(testSpeechModels) as Partial<Record<SpeechModelName, SpeechModelSpec>> } : undefined,
  });
  const appServices = services;

  // The renderer is served via a custom protocol (no HTTP server, no file://)
  const rendererRoot = resource('renderer');
  protocol.handle('app', async (request) => {
    const served = await serveRenderer(rendererRoot, request.url);
    return new Response(served.body as ConstructorParameters<typeof Response>[0], { status: served.status, headers: served.headers });
  });

  // Deny every permission (camera, location …) except the microphone for the app's own window (speech input in the chat)
  const trustedOrigins = [APP_ORIGIN, ...(isDev ? [new URL(devUrl!).origin] : [])];
  const fromMainWindow = (contents: Electron.WebContents | null) => mainWindow !== null && contents === mainWindow.webContents;
  session.defaultSession.setPermissionRequestHandler((contents, permission, respond, details) =>
    respond(
      allowsMicrophoneRequest({
        permission,
        mediaTypes: 'mediaTypes' in details ? details.mediaTypes : undefined,
        origin: details.requestingUrl,
        fromMainWindow: fromMainWindow(contents),
        trustedOrigins,
      }),
    ),
  );
  session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    allowsMicrophoneCheck({ permission, mediaType: details.mediaType, origin: requestingOrigin, fromMainWindow: fromMainWindow(contents), trustedOrigins }),
  );

  registerIpc(appServices);
  forwardEvents(appServices);
  buildMenu();
  createWindow();
  appServices.start();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // started again while quitting: the new instance has already given up, so start anew once this one has exited
    if (quitter.quitting) quitter.requestRelaunch();
    else showMainWindow(); // before `start` has run (services not ready) the window opens there anyway
  });
  app
    .whenReady()
    .then(start)
    .catch((err: unknown) => {
      if (err instanceof AppError && err.category === 'database_corrupt') {
        recoverFromDamagedDatabase(recoveryDeps(), err.message);
        return;
      }
      process.stderr.write(`[archivist] Startup failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      dialog.showErrorBox('Archivist konnte nicht gestartet werden', err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err));
      app.exit(1);
    });
  app.on('window-all-closed', () => {
    // Running in the background with the UI closed is not implemented (yet): quit the application.
    app.quit();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) showMainWindow();
  });
  app.on('before-quit', (event) => {
    if (!services) return;
    event.preventDefault();
    void quitter.quit();
  });
  process.on('uncaughtException', (err) => services?.logger.error('process', 'uncaughtException', { error: err }));
  process.on('unhandledRejection', (err) => services?.logger.error('process', 'unhandledRejection', { error: err }));
}
