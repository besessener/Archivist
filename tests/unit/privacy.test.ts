import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PrivacyService } from '../../packages/core/src/services/privacy';
import type { SettingsService } from '../../packages/core/src/services/settings';

type PrivacySettings = {
  llmMode: 'auto' | 'confirm' | 'local_only';
  neverAnalyzeExtensions: string[];
  neverAnalyzeFiles: string[];
  neverAnalyzeDirs: string[];
};

/** Datenschutz-Gate mit festen Einstellungen (ohne Datenbank). */
const gate = (privacy: Partial<PrivacySettings> = {}, platform?: string) => {
  const settings = { get: () => ({ privacy: { llmMode: 'auto', neverAnalyzeExtensions: [], neverAnalyzeFiles: [], neverAnalyzeDirs: [], ...privacy } }) };
  return new PrivacyService(settings as unknown as SettingsService, platform);
};

const allowed = { allowed: true, status: null, reason: null };

describe('Datenschutz-Gate: was darf an das externe LLM gehen?', () => {
  it('liefert den eingestellten Modus', () => {
    for (const llmMode of ['auto', 'confirm', 'local_only'] as const) expect(gate({ llmMode }).mode()).toBe(llmMode);
  });

  it('erlaubt eine gewöhnliche Datei', () => {
    expect(gate().evaluate({ path: '/daten/notiz.txt', ext: 'txt' })).toEqual(allowed);
    expect(gate().evaluate({ ext: '.pdf' })).toEqual(allowed);
  });

  it('sperrt im Modus „nur lokal“ alles, auch wenn sonst nichts dagegen spricht', () => {
    const decision = gate({ llmMode: 'local_only' }).evaluate({ path: '/daten/notiz.txt', ext: 'txt' });

    expect(decision).toEqual({ allowed: false, status: 'local_only', reason: 'Datenschutzmodus „nur lokal“ ist aktiv.' });
  });

  it('der Modus „nur lokal“ hat Vorrang vor allen anderen Gründen', () => {
    const decision = gate({ llmMode: 'local_only', neverAnalyzeExtensions: ['txt'] }).evaluate({ ext: 'txt', docExcluded: true, rootLlmAllowed: false });

    expect(decision.status).toBe('local_only');
  });

  it('sperrt Dokumente, die von der externen Analyse ausgeschlossen sind', () => {
    expect(gate().evaluate({ ext: 'txt', docExcluded: true })).toEqual({
      allowed: false,
      status: 'excluded',
      reason: 'Datei ist von der externen Analyse ausgeschlossen.',
    });
    expect(gate().evaluate({ ext: 'txt', docExcluded: false })).toEqual(allowed);
  });

  it('sperrt Dateien aus Scan-Verzeichnissen ohne LLM-Freigabe (nur bei ausdrücklichem false)', () => {
    expect(gate().evaluate({ ext: 'txt', rootLlmAllowed: false })).toEqual({
      allowed: false,
      status: 'excluded',
      reason: 'Das Scan-Verzeichnis ist von der LLM-Analyse ausgeschlossen.',
    });
    expect(gate().evaluate({ ext: 'txt', rootLlmAllowed: true })).toEqual(allowed);
    expect(gate().evaluate({ ext: 'txt' })).toEqual(allowed);
  });

  it('sperrt Dateitypen aus der Liste, unabhängig von Groß-/Kleinschreibung und führendem Punkt', () => {
    const privacy = gate({ neverAnalyzeExtensions: ['.KEY', 'pem'] });

    for (const ext of ['key', '.key', 'KEY', 'pem', '.PEM']) {
      expect(privacy.evaluate({ ext }), ext).toMatchObject({ allowed: false, status: 'excluded' });
    }
    expect(privacy.evaluate({ ext: 'key' }).reason).toBe('Dateityp .key wird nie extern analysiert.');
    expect(privacy.evaluate({ ext: 'keyx' })).toEqual(allowed);
    expect(privacy.evaluate({ ext: 'txt' })).toEqual(allowed);
  });

  it('sperrt einzelne Dateien, auch bei unterschiedlich geschriebenem Pfad', () => {
    const privacy = gate({ neverAnalyzeFiles: ['/daten/geheim/../privat.txt'] });

    const decision = privacy.evaluate({ path: '/daten/privat.txt', ext: 'txt' });
    expect(decision).toEqual({ allowed: false, status: 'excluded', reason: 'Datei ist von der externen Analyse ausgeschlossen.' });
    expect(privacy.evaluate({ path: '/daten/privat.txt.bak', ext: 'bak' })).toEqual(allowed);
    expect(privacy.evaluate({ path: '/daten/anderes/privat.txt', ext: 'txt' })).toEqual(allowed);
  });

  it('sperrt alles unterhalb gesperrter Verzeichnisse, aber nicht Nachbarn mit gleichem Namensanfang', () => {
    const privacy = gate({ neverAnalyzeDirs: ['/daten/steuer'] });

    const decision = privacy.evaluate({ path: '/daten/steuer/2025/bescheid.pdf', ext: 'pdf' });
    expect(decision).toEqual({ allowed: false, status: 'excluded', reason: 'Verzeichnis ist von der externen Analyse ausgeschlossen.' });
    expect(privacy.evaluate({ path: '/daten/steuer', ext: '' })).toMatchObject({ allowed: false });
    expect(privacy.evaluate({ path: '/daten/steuer-alt/x.pdf', ext: 'pdf' })).toEqual(allowed);
    expect(privacy.evaluate({ path: '/daten/x.pdf', ext: 'pdf' })).toEqual(allowed);
  });

  it('prüft Pfade nur, wenn einer angegeben ist', () => {
    const privacy = gate({ neverAnalyzeFiles: [path.resolve('.')], neverAnalyzeDirs: [path.resolve('.')] });

    expect(privacy.evaluate({ ext: 'txt' })).toEqual(allowed);
    expect(privacy.evaluate({ path: null, ext: 'txt' })).toEqual(allowed);
    expect(privacy.evaluate({ path: '', ext: 'txt' })).toEqual(allowed);
  });
});

describe('privacy gate: exclusions compare paths like the file system (#56)', () => {
  const tmp: string[] = [];
  afterEach(() => {
    for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const sandbox = () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-privacy-')));
    tmp.push(dir);
    fs.mkdirSync(path.join(dir, 'real', 'tax'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'real', 'tax', 'notice.pdf'), 'x');
    fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'), 'dir');
    return dir;
  };

  it('excludes files reached through a symlink to an excluded directory', () => {
    const dir = sandbox();
    const privacy = gate({ neverAnalyzeDirs: [path.join(dir, 'real', 'tax')] });

    expect(privacy.evaluate({ path: path.join(dir, 'link', 'tax', 'notice.pdf'), ext: 'pdf' })).toMatchObject({ allowed: false, status: 'excluded' });
  });

  it('excludes files when the exclusion itself was entered via a symlink', () => {
    const dir = sandbox();
    const privacy = gate({ neverAnalyzeFiles: [path.join(dir, 'link', 'tax', 'notice.pdf')] });

    expect(privacy.evaluate({ path: path.join(dir, 'real', 'tax', 'notice.pdf'), ext: 'pdf' })).toMatchObject({ allowed: false, status: 'excluded' });
    expect(privacy.evaluate({ path: path.join(dir, 'real', 'tax', 'other.pdf'), ext: 'pdf' })).toEqual(allowed);
  });

  it('ignores case on Windows for directories and files', () => {
    const privacy = gate({ neverAnalyzeDirs: ['C:\\Users\\Anna\\Steuer'], neverAnalyzeFiles: ['D:\\Daten\\Geheim.TXT'] }, 'win32');

    expect(privacy.evaluate({ path: 'c:\\users\\anna\\steuer\\2025\\bescheid.pdf', ext: 'pdf' })).toMatchObject({ allowed: false });
    expect(privacy.evaluate({ path: 'C:/USERS/ANNA/STEUER/x.pdf', ext: 'pdf' })).toMatchObject({ allowed: false });
    expect(privacy.evaluate({ path: 'd:\\daten\\geheim.txt', ext: 'txt' })).toMatchObject({ allowed: false });
    expect(privacy.evaluate({ path: 'c:\\users\\anna\\steuer-alt\\x.pdf', ext: 'pdf' })).toEqual(allowed);
    expect(privacy.evaluate({ path: 'd:\\daten\\geheim.txt.bak', ext: 'bak' })).toEqual(allowed);
  });

  it('stays case-sensitive on Linux', () => {
    const privacy = gate({ neverAnalyzeDirs: ['/daten/steuer'] }, 'linux');

    expect(privacy.evaluate({ path: '/Daten/Steuer/x.pdf', ext: 'pdf' })).toEqual(allowed);
    expect(privacy.evaluate({ path: '/daten/steuer/x.pdf', ext: 'pdf' })).toMatchObject({ allowed: false });
  });
});

describe('privacy gate for stored documents (#56)', () => {
  const doc = (over: Partial<{ sourcePath: string | null; ext: string; llmStatus: string; folderLlmAllowed: boolean }> = {}) => ({
    sourcePath: '/daten/x.txt',
    ext: 'txt',
    llmStatus: 'analyzed',
    folderLlmAllowed: true,
    ...over,
  });

  it('blocks documents from a folder without LLM permission', () => {
    expect(gate().evaluateDocument(doc({ folderLlmAllowed: false }))).toMatchObject({ allowed: false, status: 'excluded' });
    expect(gate().mayShareDocument(doc({ folderLlmAllowed: false }))).toBe(false);
    expect(gate().evaluateDocument(doc())).toEqual(allowed);
  });

  it('blocks documents excluded by the user', () => {
    expect(gate().mayShareDocument(doc({ llmStatus: 'excluded' }))).toBe(false);
  });

  it('in mode „vorher fragen“ shares only documents released for external analysis', () => {
    const privacy = gate({ llmMode: 'confirm' });

    expect(privacy.mayShareDocument(doc({ llmStatus: 'analyzed' }))).toBe(true);
    for (const llmStatus of ['pending', 'local_only']) expect(privacy.mayShareDocument(doc({ llmStatus })), llmStatus).toBe(false);
    expect(gate({ llmMode: 'auto' }).mayShareDocument(doc({ llmStatus: 'pending' }))).toBe(true);
    expect(gate({ llmMode: 'local_only' }).mayShareDocument(doc())).toBe(false);
  });
});
