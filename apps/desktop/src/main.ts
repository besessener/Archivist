import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, protocol, safeStorage, session, shell, type IpcMainInvokeEvent } from 'electron';
import { createHandlers, createIpcDispatcher, createServices, type HostApi, type SecretCipher, type Services } from '@archivist/core';
import { IPC_CHANNELS, type AppNotification } from '@archivist/shared';
import { appUserModelId } from './app-id';
import { JOB_INTERRUPT_TIMEOUT_MS, QuitController } from './lifecycle';
import { APP_ORIGIN, serveRenderer } from './renderer-server';

/**
 * Electron-Main-Prozess: App-Lebenszyklus, sichere Fenster, IPC-Allowlist und Betriebssystemzugriffe.
 * Die Geschäftslogik liegt vollständig im Service-Layer (@archivist/core); rechenintensive Arbeit läuft in Worker-Threads.
 */
const isDev = Boolean(process.env.ARCHIVIST_DEV_URL);
const testMode = process.env.ARCHIVIST_TEST_MODE === '1';

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

if (process.env.ARCHIVIST_DATA_DIR) app.setPath('userData', path.join(process.env.ARCHIVIST_DATA_DIR, '.electron'));
// Windows shows desktop notifications only for a process whose AppUserModelID matches a Start menu shortcut
if (process.platform === 'win32') app.setAppUserModelId(appUserModelId(app.isPackaged, process.execPath));

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
const resource = (...p: string[]) => path.join(__dirname, ...p);

/** Verschlüsselung über Electron safeStorage (Windows DPAPI; die Linux-Zweige dienen nur Entwicklung und CI). */
const cipher: SecretCipher = {
  isAvailable: () => {
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (process.platform === 'linux') {
      const backend = safeStorage.getSelectedStorageBackend();
      // „basic_text“ legt Schlüssel nur obfuskiert ab – nur im ausdrücklichen Testmodus zulässig
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
    const opts: Electron.OpenDialogOptions = { title: title ?? 'Verzeichnis auswählen', properties: ['openDirectory'] };
    if (process.env.ARCHIVIST_TEST_PICK_DIR) return process.env.ARCHIVIST_TEST_PICK_DIR; // E2E: kein nativer Dialog
    const res = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts);
    return res.canceled || res.filePaths.length === 0 ? null : (res.filePaths[0] ?? null);
  },
  openPath: (p) => shell.openPath(p),
  revealPath: (p) => shell.showItemInFolder(p),
};

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  const trusted = url.startsWith(`${APP_ORIGIN}/`) || (isDev && url.startsWith(process.env.ARCHIVIST_DEV_URL!));
  return trusted && mainWindow !== null && event.sender === mainWindow.webContents;
}

function registerIpc(svc: Services): void {
  const dispatch = createIpcDispatcher(createHandlers(svc, host), (channel, err) => svc.logger.error('ipc', `Fehler in ${channel}`, { error: err }));
  for (const channel of IPC_CHANNELS) {
    ipcMain.handle(channel, async (event, input: unknown) => {
      if (!isTrustedSender(event)) {
        return { ok: false, error: { category: 'permission_error', message: 'Unbefugter Absender.', retryable: false } };
      }
      return dispatch(channel, input);
    });
  }
}

function forwardEvents(svc: Services): void {
  const send = (channel: string, payload: unknown) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };
  let timer: NodeJS.Timeout | null = null;
  const scopes = new Set<string>();
  svc.events.on('data:changed', (e: { scopes: string[] }) => {
    for (const s of e.scopes) scopes.add(s);
    timer ??= setTimeout(() => {
      send('data:changed', { scopes: [...scopes] });
      scopes.clear();
      timer = null;
    }, 60);
  });
  svc.events.on('job:updated', (job) => send('job:updated', job));
  svc.events.on('status:changed', () => send('status:changed', {}));
  svc.events.on('notification:new', (n: AppNotification) => {
    send('notification:new', n);
    if (svc.settings.get().notifications.desktop && Notification.isSupported()) {
      const note = new Notification({ title: n.title, body: n.description.slice(0, 200), silent: n.priority === 'low' });
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
  mainWindow.on('page-title-updated', (e) => e.preventDefault());
  const wc = mainWindow.webContents;
  const allowed = (url: string) => url.startsWith(`${APP_ORIGIN}/`) || (isDev && url.startsWith(process.env.ARCHIVIST_DEV_URL!));
  wc.on('will-navigate', (e, url) => {
    if (!allowed(url)) e.preventDefault();
  });
  wc.on('will-redirect', (e, url) => {
    if (!allowed(url)) e.preventDefault();
  });
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-attach-webview', (e) => e.preventDefault());
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
  // Nur im ausdrücklichen Testmodus (CI ohne Schlüsselbund) ist der unsichere Fallback zulässig.
  if (testMode && process.platform === 'linux') safeStorage.setUsePlainTextEncryption(true);
  const migrations = resource('migrations');
  services = createServices({
    dataRoot: dataRoot(),
    migrationsFolder: migrations,
    cipher,
    workerFile: resource('worker.cjs'),
  });
  const svc = services;

  // Renderer wird über ein eigenes Protokoll ausgeliefert (kein HTTP-Server, kein file://)
  const rendererRoot = resource('renderer');
  protocol.handle('app', async (request) => {
    const res = await serveRenderer(rendererRoot, request.url);
    return new Response(res.body as ConstructorParameters<typeof Response>[0], { status: res.status, headers: res.headers });
  });

  // Berechtigungsanfragen (Kamera, Standort …) grundsätzlich ablehnen
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  registerIpc(svc);
  forwardEvents(svc);
  buildMenu();
  createWindow();
  svc.start();
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
      process.stderr.write(`[archivist] Start fehlgeschlagen: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      dialog.showErrorBox('Archivist konnte nicht gestartet werden', err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err));
      app.exit(1);
    });
  app.on('window-all-closed', () => {
    // Hintergrundbetrieb bei geschlossener Oberfläche ist (noch) nicht implementiert: Anwendung beenden.
    app.quit();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) showMainWindow();
  });
  app.on('before-quit', (e) => {
    if (!services) return;
    e.preventDefault();
    void quitter.quit();
  });
  process.on('uncaughtException', (err) => services?.logger.error('process', 'uncaughtException', { error: err }));
  process.on('unhandledRejection', (err) => services?.logger.error('process', 'unhandledRejection', { error: err }));
}
