import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ID, appUserModelId } from '../../apps/desktop/src/app-id';

describe('App-ID', () => {
  it('stimmt mit der appId der Packaging-Konfiguration überein', () => {
    const yml = fs.readFileSync(path.resolve(__dirname, '../../apps/desktop/electron-builder.yml'), 'utf8');
    expect(yml).toMatch(new RegExp(`^appId: ${APP_ID.replaceAll('.', '\\.')}$`, 'm'));
    expect(APP_ID).toBe('io.github.besessener.archivist');
  });

  it('setzt die AppUserModelID der installierten App auf die App-ID, in der Entwicklung auf electron.exe', () => {
    expect(appUserModelId(true, 'C:\\Programme\\Archivist\\Archivist.exe')).toBe(APP_ID);
    expect(appUserModelId(false, 'C:\\repo\\node_modules\\electron\\dist\\electron.exe')).toBe('C:\\repo\\node_modules\\electron\\dist\\electron.exe');
  });
});
