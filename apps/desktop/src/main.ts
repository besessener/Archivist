import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, protocol, safeStorage, session, shell, type IpcMainInvokeEvent } from 'electron';
import { createHandlers, createIpcDispatcher, createServices, type HostApi, type SecretCipher, type Services } from '@archivist/core';
import { IPC_CHANNELS, type AppNotification } from '@archivist/shared';
import { appUserModelId } from './app-id';
import { JOB_INTERRUPT_TIMEOUT_MS, QuitController } from './lifecycle';
import { isExternalWebUrl } from './external-links';
import { APP_ORIGIN, serveRenderer } from './renderer-server';

// Electron main process: lifecycle, secure windows, IPC allowlist and OS access; the business logic lives in @archivist/core.
const isDev = Boolean(process.env.ARCHIVIST_DEV_URL);
const testMode = process.env.ARCHIVIST_TEST_MODE === '1';

// the interface is German only: date and time fields follow Chromium's language, not the operating system's
app.commandLine.appendSwitch('lang', 'de-DE');
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

const dataRoot = () => process.env.ARCHIVIST_DATA_DIR ?? path.join(app.getPath('documents'), 'Archivist');
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
    if (process.env.ARCHIVIST_TEST_PICK_DIR) return process.env.ARCHIVIST_TEST_PICK_DIR; // E2E: no native dialog
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
};

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  const trusted = url.startsWith(`${APP_ORIGIN}/`) || (isDev && url.startsWith(process.env.ARCHIVIST_DEV_URL!));
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
  const allowed = (url: string) => url.startsWith(`${APP_ORIGIN}/`) || (isDev && url.startsWith(process.env.ARCHIVIST_DEV_URL!));
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
  void mainWindow.loadURL(isDev ? process.env.ARCHIVIST_DEV_URL! : `${APP_ORIGIN}/chat/`);
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
    migrationsFolder: migrations,
    cipher,
    appVersion: app.getVersion(),
    workerFile: resource('worker.cjs'),
    readerFile: resource('db-reader.cjs'),
  });
  const appServices = services;

  // The renderer is served via a custom protocol (no HTTP server, no file://)
  const rendererRoot = resource('renderer');
  protocol.handle('app', async (request) => {
    const served = await serveRenderer(rendererRoot, request.url);
    return new Response(served.body as ConstructorParameters<typeof Response>[0], { status: served.status, headers: served.headers });
  });

  // Always deny permission requests (camera, location …)
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

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
