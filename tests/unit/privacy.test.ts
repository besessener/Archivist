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

/** Privacy gate with fixed settings (without a database). */
const gate = (privacy: Partial<PrivacySettings> = {}, platform?: string) => {
  const settings = { get: () => ({ privacy: { llmMode: 'auto', neverAnalyzeExtensions: [], neverAnalyzeFiles: [], neverAnalyzeDirs: [], ...privacy } }) };
  return new PrivacyService(settings as unknown as SettingsService, platform);
};

const allowed = { allowed: true, status: null, reason: null };

describe('privacy gate: what may be sent to the external LLM?', () => {
  it('returns the configured mode', () => {
    for (const llmMode of ['auto', 'confirm', 'local_only'] as const) expect(gate({ llmMode }).mode()).toBe(llmMode);
  });

  it('allows an ordinary file', () => {
    expect(gate().evaluate({ path: '/daten/notiz.txt', ext: 'txt' })).toEqual(allowed);
    expect(gate().evaluate({ ext: '.pdf' })).toEqual(allowed);
  });

  it('blocks everything in mode „nur lokal“, even if nothing else speaks against it', () => {
    const decision = gate({ llmMode: 'local_only' }).evaluate({ path: '/daten/notiz.txt', ext: 'txt' });

    expect(decision).toEqual({ allowed: false, status: 'local_only', reason: 'Datenschutzmodus „nur lokal“ ist aktiv.' });
  });

  it('mode „nur lokal“ takes precedence over all other reasons', () => {
    const decision = gate({ llmMode: 'local_only', neverAnalyzeExtensions: ['txt'] }).evaluate({ ext: 'txt', docExcluded: true, rootLlmAllowed: false });

    expect(decision.status).toBe('local_only');
  });

  it('blocks documents that are excluded from external analysis', () => {
    expect(gate().evaluate({ ext: 'txt', docExcluded: true })).toEqual({
      allowed: false,
      status: 'excluded',
      reason: 'Datei ist von der externen Analyse ausgeschlossen.',
    });
    expect(gate().evaluate({ ext: 'txt', docExcluded: false })).toEqual(allowed);
  });

  it('blocks files from scan directories without LLM permission (only on an explicit false)', () => {
    expect(gate().evaluate({ ext: 'txt', rootLlmAllowed: false })).toEqual({
      allowed: false,
      status: 'excluded',
      reason: 'Das Scan-Verzeichnis ist von der LLM-Analyse ausgeschlossen.',
    });
    expect(gate().evaluate({ ext: 'txt', rootLlmAllowed: true })).toEqual(allowed);
    expect(gate().evaluate({ ext: 'txt' })).toEqual(allowed);
  });

  it('blocks file types from the list regardless of case and leading dot', () => {
    const privacy = gate({ neverAnalyzeExtensions: ['.KEY', 'pem'] });

    for (const ext of ['key', '.key', 'KEY', 'pem', '.PEM']) {
      expect(privacy.evaluate({ ext }), ext).toMatchObject({ allowed: false, status: 'excluded' });
    }
    expect(privacy.evaluate({ ext: 'key' }).reason).toBe('Dateityp .key wird nie extern analysiert.');
    expect(privacy.evaluate({ ext: 'keyx' })).toEqual(allowed);
    expect(privacy.evaluate({ ext: 'txt' })).toEqual(allowed);
  });

  it('strips only a single leading dot and compares the whole extension', () => {
    expect(gate({ neverAnalyzeExtensions: ['targz'] }).evaluate({ ext: 'tar.gz' })).toEqual(allowed);
    expect(gate({ neverAnalyzeExtensions: ['tar.gz'] }).evaluate({ ext: 'targz' })).toEqual(allowed);
    expect(gate({ neverAnalyzeExtensions: ['tar.gz'] }).evaluate({ ext: '.tar.gz' })).toMatchObject({ allowed: false });
  });

  it('blocks individual files, even when the path is written differently', () => {
    const privacy = gate({ neverAnalyzeFiles: ['/daten/geheim/../privat.txt'] });

    const decision = privacy.evaluate({ path: '/daten/privat.txt', ext: 'txt' });
    expect(decision).toEqual({ allowed: false, status: 'excluded', reason: 'Datei ist von der externen Analyse ausgeschlossen.' });
    expect(privacy.evaluate({ path: '/daten/privat.txt.bak', ext: 'bak' })).toEqual(allowed);
    expect(privacy.evaluate({ path: '/daten/anderes/privat.txt', ext: 'txt' })).toEqual(allowed);
  });

  it('blocks everything below blocked directories, but not siblings with the same name prefix', () => {
    const privacy = gate({ neverAnalyzeDirs: ['/daten/steuer'] });

    const decision = privacy.evaluate({ path: '/daten/steuer/2025/bescheid.pdf', ext: 'pdf' });
    expect(decision).toEqual({ allowed: false, status: 'excluded', reason: 'Verzeichnis ist von der externen Analyse ausgeschlossen.' });
    expect(privacy.evaluate({ path: '/daten/steuer', ext: '' })).toMatchObject({ allowed: false });
    expect(privacy.evaluate({ path: '/daten/steuer-alt/x.pdf', ext: 'pdf' })).toEqual(allowed);
    expect(privacy.evaluate({ path: '/daten/x.pdf', ext: 'pdf' })).toEqual(allowed);
  });

  it('checks paths only if one is given', () => {
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

  it('resolves symlinks also for files that do not exist yet', () => {
    const dir = sandbox();
    const privacy = gate({ neverAnalyzeDirs: [path.join(dir, 'real', 'tax')] });

    expect(privacy.evaluate({ path: path.join(dir, 'link', 'tax', 'neu', 'bescheid.pdf'), ext: 'pdf' })).toMatchObject({ allowed: false });
  });

  it('excludes the real files of a directory that was entered via a symlink', () => {
    const dir = sandbox();
    const privacy = gate({ neverAnalyzeDirs: [path.join(dir, 'link', 'tax')] });

    expect(privacy.evaluate({ path: path.join(dir, 'real', 'tax', 'notice.pdf'), ext: 'pdf' })).toMatchObject({ allowed: false });
    expect(privacy.evaluate({ path: path.join(dir, 'real', 'other.pdf'), ext: 'pdf' })).toEqual(allowed);
  });

  it('compares paths of another platform lexically only, without consulting this file system', () => {
    const dir = sandbox();
    const otherPosixPlatform = process.platform === 'linux' ? 'darwin' : 'linux';
    const privacy = gate({ neverAnalyzeDirs: [path.join(dir, 'real', 'tax')] }, otherPosixPlatform);

    expect(privacy.evaluate({ path: path.join(dir, 'link', 'tax', 'notice.pdf'), ext: 'pdf' })).toEqual(allowed);
    expect(privacy.evaluate({ path: path.join(dir, 'real', 'tax', 'notice.pdf'), ext: 'pdf' })).toMatchObject({ allowed: false });
  });

  it('does not exclude the parent of an excluded directory or another Windows drive', () => {
    expect(gate({ neverAnalyzeDirs: ['/daten/steuer'] }).evaluate({ path: '/daten', ext: '' })).toEqual(allowed);
    const windows = gate({ neverAnalyzeDirs: ['C:\\Daten'] }, 'win32');
    expect(windows.evaluate({ path: 'D:\\Daten\\x.pdf', ext: 'pdf' })).toEqual(allowed);
    expect(windows.evaluate({ path: 'C:\\', ext: '' })).toEqual(allowed);
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
