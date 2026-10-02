/** Must match `appId` in electron-builder.yml: Windows shows notifications only for the AppUserModelID of the installer's shortcuts. */
export const APP_ID = 'io.github.besessener.archivist';

/** Windows AppUserModelID: `APP_ID` when installed; an unpackaged build is only known by its `electron.exe` path. */
export function appUserModelId(build: { packaged: boolean; execPath: string }): string {
  return build.packaged ? APP_ID : build.execPath;
}
