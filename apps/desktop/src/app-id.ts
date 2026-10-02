/**
 * Application id (reverse DNS of a domain we control: besessener.github.io). Must match `appId` in electron-builder.yml:
 * the NSIS installer stamps it on the Start menu and desktop shortcuts as AppUserModelID, and Windows only shows
 * desktop notifications of a process whose AppUserModelID matches such a shortcut. Kept free of Electron for tests.
 */
export const APP_ID = 'io.github.besessener.archivist';

/**
 * AppUserModelID to set on Windows: the installed app uses `APP_ID`; an unpackaged development build runs as
 * `electron.exe`, which Windows only knows by its path (pin it to the Start menu to see notifications).
 */
export function appUserModelId(isPackaged: boolean, execPath: string): string {
  return isPackaged ? APP_ID : execPath;
}
