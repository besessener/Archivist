import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Settings, SettingsPatch } from '@archivist/shared';
import { SettingsService } from '../../packages/core/src/services/settings';

type SectionKey = 'profile' | 'llm' | 'scan' | 'privacy' | 'notifications' | 'logs' | 'backups' | 'consistency' | 'ocr' | 'agent';

/**
 * Two complete, valid, non-default value sets per section. Every field differs between A and B,
 * so saving a single field from B is observable and must leave the A values of all other fields untouched.
 */
const SECTIONS: Record<SectionKey, { a: Record<string, unknown>; b: Record<string, unknown> }> = {
  profile: {
    a: { name: 'Erika Musterfrau', nicknames: ['Eri'] },
    b: { name: 'Max Mustermann', nicknames: ['Maxi', 'MM'] },
  },
  llm: {
    a: { baseUrl: 'https://llm-a.example.com/v1', model: 'model-a', reasoningEffort: 'high', timeoutMs: 120000, maxInputChars: 50000, embeddingModel: 'emb-a' },
    b: { baseUrl: 'https://llm-b.example.com/v1', model: 'model-b', reasoningEffort: null, timeoutMs: 30000, maxInputChars: 8000, embeddingModel: 'emb-b' },
  },
  scan: {
    a: { enabled: true, onStartup: true, periodic: true, intervalMinutes: 15, maxFileSizeMb: 10, allowedExtensions: ['pdf'], autoAnalyze: true },
    b: { enabled: false, onStartup: false, periodic: false, intervalMinutes: 240, maxFileSizeMb: 5, allowedExtensions: ['txt', 'md'], autoAnalyze: false },
  },
  privacy: {
    a: { llmMode: 'auto', neverAnalyzeDirs: ['/geheim'], neverAnalyzeExtensions: ['eml'], neverAnalyzeFiles: ['/a/b.pdf'] },
    b: { llmMode: 'local_only', neverAnalyzeDirs: ['/privat', '/hr'], neverAnalyzeExtensions: ['xlsx'], neverAnalyzeFiles: ['/c/d.docx'] },
  },
  notifications: {
    a: { desktop: true, reminderTime: '07:30' },
    b: { desktop: false, reminderTime: '18:00' },
  },
  logs: {
    a: { level: 'debug', retentionDays: 7 },
    b: { level: 'error', retentionDays: 90 },
  },
  backups: {
    a: { keep: 3, autoOnStartup: true, includeArchive: true },
    b: { keep: 20, autoOnStartup: false, includeArchive: false },
  },
  consistency: {
    a: { onStartup: false, intervalHours: 6, staleOpenItemDays: 14, autoMergePersons: false },
    b: { onStartup: true, intervalHours: 48, staleOpenItemDays: 60, autoMergePersons: true },
  },
  ocr: {
    a: { enabled: false, languages: 'eng' },
    b: { enabled: true, languages: 'deu+fra' },
  },
  agent: {
    a: {
      enabled: false,
      mode: 'ask',
      massActionThreshold: 20,
      adapter: 'anthropic',
      effort: 'max',
      chatLimits: { maxRounds: 10, maxTokens: 100_000, timeoutMs: 60_000 },
      backgroundLimits: { maxRounds: 12, maxTokens: 120_000, timeoutMs: 90_000 },
      maxRetries: 1,
      prices: { 'model-a': { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.2 } },
      background: {
        inbox: false,
        archiveCheck: true,
        links: false,
        nightlyHour: 2,
        deadlineWatch: false,
        deadlineLeadDays: 7,
        weeklyReview: false,
        weeklyReviewDay: 5,
      },
      learning: false,
    },
    b: {
      enabled: true,
      mode: 'auto',
      massActionThreshold: 500,
      adapter: 'openai',
      effort: 'low',
      chatLimits: { maxRounds: 20, maxTokens: 200_000, timeoutMs: 120_000 },
      backgroundLimits: { maxRounds: 30, maxTokens: 300_000, timeoutMs: 180_000 },
      maxRetries: 5,
      prices: {},
      background: {
        inbox: true,
        archiveCheck: false,
        links: true,
        nightlyHour: null,
        deadlineWatch: true,
        deadlineLeadDays: 30,
        weeklyReview: true,
        weeklyReviewDay: 0,
      },
      learning: true,
    },
  },
};

const SECTION_KEYS = Object.keys(SECTIONS) as SectionKey[];

describe('SettingsPatch (Issue #55)', () => {
  it('covers every object section of Settings and is valid for both value sets', () => {
    const objectSections = Object.entries(Settings.parse({}))
      .filter(([, v]) => v !== null && typeof v === 'object' && !Array.isArray(v))
      .map(([k]) => k)
      .sort();
    expect([...SECTION_KEYS].sort()).toEqual(objectSections);
    for (const key of SECTION_KEYS) {
      expect(Object.keys(SECTIONS[key].a).sort()).toEqual(Object.keys(Settings.parse({})[key]).sort());
      expect(Object.keys(SECTIONS[key].b).sort()).toEqual(Object.keys(SECTIONS[key].a).sort());
    }
  });

  it.each(SECTION_KEYS)('section %s: the patch schema adds no default values', (key) => {
    expect(SettingsPatch.parse({ [key]: {} })).toEqual({ [key]: {} });
    for (const [field, value] of Object.entries(SECTIONS[key].a)) {
      expect(SettingsPatch.parse({ [key]: { [field]: value } })).toEqual({ [key]: { [field]: value } });
    }
  });

  it('reproduction from the issue: backups.autoOnStartup alone stays alone', () => {
    expect(SettingsPatch.parse({ backups: { autoOnStartup: true } })).toEqual({ backups: { autoOnStartup: true } });
  });

  it('still validates the fields it contains', () => {
    expect(SettingsPatch.safeParse({ backups: { keep: 0 } }).success).toBe(false);
    expect(SettingsPatch.safeParse({ scan: { intervalMinutes: 1 } }).success).toBe(false);
    expect(SettingsPatch.safeParse({ ocr: { languages: 'deutsch' } }).success).toBe(false);
    expect(SettingsPatch.safeParse({ privacy: { llmMode: 'always' } }).success).toBe(false);
  });
});

describe('SettingsService.update: saving one field keeps the rest (Issue #55)', () => {
  let dir: string;
  let file: string;
  let archiveRoot: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-settings-'));
    file = path.join(dir, 'config', 'settings.json');
    archiveRoot = path.join(dir, 'archive');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function seeded(): SettingsService {
    const svc = new SettingsService(file, archiveRoot);
    svc.update(Object.fromEntries(SECTION_KEYS.map((k) => [k, SECTIONS[k].a])));
    return svc;
  }

  it.each(SECTION_KEYS)('section %s: every single field can be saved without touching the others', (key) => {
    const svc = seeded();
    const before = svc.get();
    expect(before[key]).toEqual(SECTIONS[key].a);
    for (const [field, value] of Object.entries(SECTIONS[key].b)) {
      const after = svc.update({ [key]: { [field]: value } });
      expect(after).toEqual({ ...before, [key]: { ...SECTIONS[key].a, [field]: value } });
      // persisted as well
      expect(new SettingsService(file, archiveRoot).get()).toEqual(after);
      svc.update({ [key]: { [field]: SECTIONS[key].a[field] } });
      expect(svc.get()).toEqual(before);
    }
  });

  it('a field explicitly set to undefined keeps its current value', () => {
    const svc = seeded();
    const after = svc.update({ backups: { autoOnStartup: false, keep: undefined, includeArchive: undefined } });
    expect(after.backups).toEqual({ keep: 3, autoOnStartup: false, includeArchive: true });
  });

  it('fields of a section that were never saved still get their defaults after the merge', () => {
    const svc = new SettingsService(file, archiveRoot);
    const after = svc.update({ backups: { autoOnStartup: true } });
    expect(after.backups).toEqual({ ...Settings.parse({}).backups, autoOnStartup: true });
  });
});
