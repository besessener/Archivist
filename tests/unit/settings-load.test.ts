import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Settings, SettingsPatch, isOcrLanguageList } from '@archivist/shared';
import { repairSettings, SettingsService, settingsLoadNotification } from '../../packages/core/src/services/settings';

const defaults = Settings.parse({});

/** A complete, valid, non-default settings file (as the user would have saved it). */
function userSettings(archiveRoot: string) {
  return {
    ...defaults,
    setupCompleted: true,
    profile: { name: 'Erika Musterfrau', nicknames: ['Eri'] },
    llm: { ...defaults.llm, baseUrl: 'https://llm.example.com/v1', model: 'model-a', timeoutMs: 120000 },
    archiveRoot,
    scan: { ...defaults.scan, enabled: true, intervalMinutes: 15 },
    privacy: { llmMode: 'local_only', neverAnalyzeDirs: ['/geheim'], neverAnalyzeExtensions: ['eml'], neverAnalyzeFiles: ['/a/b.pdf'], maskPersonalData: false },
    backups: { keep: 3, autoOnStartup: true, includeArchive: true },
    ocr: { enabled: true, languages: 'deu+eng' },
  };
}

describe('ocr.languages validation matches the OCR module (Issue #57)', () => {
  it.each(['deu', 'deu+eng', 'deu+chi_sim', 'chi_tra+jpn', 'deu+eng+fra'])('accepts %s', (languages) => {
    expect(isOcrLanguageList(languages)).toBe(true);
    expect(Settings.safeParse({ ocr: { languages } }).success).toBe(true);
    expect(SettingsPatch.safeParse({ ocr: { languages } }).success).toBe(true);
  });

  it.each(['', 'deutsch', 'Deu', 'de', 'deu+', '+deu', 'deu eng', 'deu+chi_', 'deu+chi-sim'])('rejects %j', (languages) => {
    expect(isOcrLanguageList(languages)).toBe(false);
    expect(Settings.safeParse({ ocr: { languages } }).success).toBe(false);
  });
});

describe('repairSettings', () => {
  it('resets only the invalid fields and keeps every valid section and field', () => {
    const raw = userSettings('/archiv');
    const { settings, invalidFields } = repairSettings({
      ...raw,
      ocr: { enabled: false, languages: 'deutsch' },
      scan: { ...raw.scan, intervalMinutes: 1 },
    });
    expect(invalidFields.sort()).toEqual(['ocr.languages', 'scan.intervalMinutes']);
    expect(settings).toEqual({
      ...raw,
      ocr: { enabled: false, languages: defaults.ocr.languages },
      scan: { ...raw.scan, intervalMinutes: defaults.scan.intervalMinutes },
    });
  });

  it('resets a section that is not an object and invalid top-level values', () => {
    const raw = userSettings('/archiv');
    const { settings, invalidFields } = repairSettings({ ...raw, privacy: 'local_only', language: 'en', setupCompleted: 'ja' });
    expect(invalidFields.sort()).toEqual(['language', 'privacy', 'setupCompleted']);
    expect(settings).toEqual({ ...raw, privacy: defaults.privacy, language: 'de', setupCompleted: false });
  });

  it('resets an array field with an invalid element as a whole', () => {
    const raw = userSettings('/archiv');
    const { settings, invalidFields } = repairSettings({ ...raw, profile: { name: 'Erika', nicknames: ['Eri', 5] } });
    expect(invalidFields).toEqual(['profile.nicknames']);
    expect(settings.profile).toEqual({ name: 'Erika', nicknames: [] });
    expect(settings.privacy).toEqual(raw.privacy);
  });

  it('reports nothing for valid settings and does not modify its input', () => {
    const raw = { ...userSettings('/archiv'), ocr: { languages: 'x' } };
    const copy = structuredClone(raw);
    repairSettings(raw);
    expect(raw).toEqual(copy);
    expect(repairSettings(userSettings('/archiv')).invalidFields).toEqual([]);
  });
});

describe('SettingsService.load with an invalid settings.json (Issue #57)', () => {
  let dir: string;
  let configDir: string;
  let file: string;
  let archiveRoot: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-settings-load-'));
    configDir = path.join(dir, 'config');
    file = path.join(configDir, 'settings.json');
    archiveRoot = path.join(dir, 'archive');
    fs.mkdirSync(configDir, { recursive: true });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const backups = (kind: string) => fs.readdirSync(configDir).filter((f) => f.startsWith(`settings.json.${kind}-`));

  it('keeps all valid settings, backs up the original and reports the affected fields', () => {
    const saved = userSettings('/mein/archiv');
    const original = JSON.stringify({ ...saved, ocr: { enabled: true, languages: 'deu+chi-sim' } }, null, 2);
    fs.writeFileSync(file, original);

    const svc = new SettingsService({ file, defaultArchiveRoot: archiveRoot });
    const expected = { ...saved, ocr: { enabled: true, languages: 'deu+eng' } };
    expect(svc.get()).toEqual(expected);
    // local_only, exclusions, archive path and LLM configuration survive
    expect(svc.get().privacy.llmMode).toBe('local_only');
    expect(svc.get().archiveRoot).toBe('/mein/archiv');

    const [backup] = backups('invalid');
    expect(backup).toMatch(/^settings\.json\.invalid-\d+$/);
    expect(fs.readFileSync(path.join(configDir, backup!), 'utf8')).toBe(original);
    // the repaired file is valid again, so the next start reports nothing
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(expected);

    const problem = svc.takeLoadProblem();
    expect(problem).toEqual({ kind: 'invalid', fields: ['ocr.languages'], backupFile: path.join(configDir, backup!) });
    expect(svc.takeLoadProblem()).toBeNull();

    const again = new SettingsService({ file, defaultArchiveRoot: archiveRoot });
    expect(again.get()).toEqual(expected);
    expect(again.takeLoadProblem()).toBeNull();
    expect(backups('invalid')).toHaveLength(1);
  });

  it('a later update does not bring back the defaults of the other sections', () => {
    fs.writeFileSync(file, JSON.stringify({ ...userSettings('/mein/archiv'), scan: { enabled: true, intervalMinutes: 'oft' } }));
    const svc = new SettingsService({ file, defaultArchiveRoot: archiveRoot });
    const after = svc.update({ backups: { keep: 7 } });
    expect(after.privacy.llmMode).toBe('local_only');
    expect(after.llm.model).toBe('model-a');
    expect(after.scan).toEqual({ ...defaults.scan, enabled: true });
    expect(new SettingsService({ file, defaultArchiveRoot: archiveRoot }).get()).toEqual(after);
  });

  it('a valid file is loaded unchanged without backup or problem', () => {
    fs.writeFileSync(file, JSON.stringify(userSettings('/mein/archiv')));
    const svc = new SettingsService({ file, defaultArchiveRoot: archiveRoot });
    expect(svc.get()).toEqual(userSettings('/mein/archiv'));
    expect(svc.takeLoadProblem()).toBeNull();
    expect(fs.readdirSync(configDir)).toEqual(['settings.json']);
  });

  it('a missing file is created with defaults and reports nothing', () => {
    const svc = new SettingsService({ file, defaultArchiveRoot: archiveRoot });
    expect(svc.get()).toEqual({ ...defaults, archiveRoot });
    expect(svc.takeLoadProblem()).toBeNull();
    expect(fs.existsSync(file)).toBe(true);
  });

  it.each([
    ['broken JSON', '{"setupCompleted": true,'],
    ['no object', '[1, 2]'],
  ])('%s: the file is moved aside and reported as unreadable', (_, content) => {
    fs.writeFileSync(file, content);
    const svc = new SettingsService({ file, defaultArchiveRoot: archiveRoot });
    expect(svc.get()).toEqual({ ...defaults, archiveRoot });
    const [backup] = backups('corrupt');
    expect(fs.readFileSync(path.join(configDir, backup!), 'utf8')).toBe(content);
    expect(svc.takeLoadProblem()).toEqual({ kind: 'unreadable', fields: [], backupFile: path.join(configDir, backup!) });
  });
});

describe('settingsLoadNotification', () => {
  it('names the affected fields and the backup file in German', () => {
    const n = settingsLoadNotification({
      kind: 'invalid',
      fields: ['ocr.languages', 'scan.intervalMinutes'],
      backupFile: '/x/config/settings.json.invalid-123',
    });
    expect(n.title).toBe('Ungültige Einstellungen zurückgesetzt');
    expect(n.description).toContain('ocr.languages, scan.intervalMinutes');
    expect(n.description).toContain('settings.json.invalid-123');
    expect(n.description).toContain('Alle anderen Einstellungen bleiben erhalten');
    expect(n.type).toBe('system');
    expect(n.proposedActions).toEqual([{ label: 'Einstellungen öffnen', kind: 'navigate', target: '/settings/' }]);
  });

  it('says so when the original could not be backed up', () => {
    const n = settingsLoadNotification({ kind: 'invalid', fields: ['language'], backupFile: null });
    expect(n.description).toContain('konnte nicht gesichert werden');
  });
});
