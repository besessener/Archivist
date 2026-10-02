import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ID, appUserModelId } from '../../apps/desktop/src/app-id';

describe('app ID', () => {
  it('matches the appId of the packaging configuration', () => {
    const yml = fs.readFileSync(path.resolve(__dirname, '../../apps/desktop/electron-builder.yml'), 'utf8');
    expect(yml).toMatch(new RegExp(`^appId: ${APP_ID.replaceAll('.', '\\.')}$`, 'm'));
    expect(APP_ID).toBe('io.github.besessener.archivist');
  });

  it('sets the AppUserModelID of the installed app to the app ID, and to electron.exe in development', () => {
    expect(appUserModelId({ packaged: true, execPath: 'C:\\Programme\\Archivist\\Archivist.exe' })).toBe(APP_ID);
    expect(appUserModelId({ packaged: false, execPath: 'C:\\repo\\node_modules\\electron\\dist\\electron.exe' })).toBe(
      'C:\\repo\\node_modules\\electron\\dist\\electron.exe',
    );
  });
});
