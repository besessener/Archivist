import fs from 'node:fs';
import path from 'node:path';
import { Settings, SettingsPatch } from '@archivist/shared';
import type { EventBus } from '../context';
import type { NotificationInput } from './notifications';
import { AppError, validationError } from '../util/errors';

/** Drops fields explicitly set to `undefined`, so they keep their current value instead of falling back to the default. */
function definedFields(section: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(section).filter(([, v]) => v !== undefined));
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Section keys of `Settings` (nested objects whose fields are validated one by one). */
const SECTION_KEYS = new Set(
  Object.entries(Settings.parse({}))
    .filter(([, value]) => isPlainObject(value))
    .map(([key]) => key),
);

/** What went wrong while loading settings.json; reported once as a notification after startup. */
export interface SettingsLoadProblem {
  /** `invalid`: single values failed validation and were reset; `unreadable`: the file was no valid JSON object. */
  kind: 'invalid' | 'unreadable';
  /** Affected fields (`section.field` or top-level key), empty for `unreadable`. */
  fields: string[];
  /** Where the original file was saved, or null if saving it failed. */
  backupFile: string | null;
}

/**
 * Validates raw settings field by field: every invalid field is removed so that only it falls back to its default,
 * while all valid sections and fields are kept. Returns the repaired settings and the affected field paths.
 */
export function repairSettings(raw: Record<string, unknown>): { settings: Settings; invalidFields: string[] } {
  const draft = structuredClone(raw);
  const invalid = new Set<string>();
  // Each round removes at least one offending field, so this ends after at most (number of fields) rounds.
  for (;;) {
    const parsed = Settings.safeParse(draft);
    if (parsed.success) return { settings: parsed.data, invalidFields: [...invalid] };
    let removed = false;
    for (const issue of parsed.error.issues) {
      const [key, field] = issue.path;
      if (typeof key !== 'string') continue;
      const section = draft[key];
      if (SECTION_KEYS.has(key) && typeof field === 'string' && isPlainObject(section)) {
        if (field in section) {
          delete section[field];
          invalid.add(`${key}.${field}`);
          removed = true;
        }
      } else if (key in draft) {
        delete draft[key];
        invalid.add(key);
        removed = true;
      }
    }
    // Should not happen (e.g. a cross-field rule); fall back to the defaults instead of looping forever.
    if (!removed) return { settings: Settings.parse({}), invalidFields: [...invalid, ...Object.keys(draft)] };
  }
}

/** German notification describing a settings load problem (affected fields and where the original was saved). */
export function settingsLoadNotification(problem: SettingsLoadProblem): NotificationInput {
  const backupName = problem.backupFile ? path.basename(problem.backupFile) : null;
  const backupText = backupName
    ? `Die ursprüngliche Datei wurde als „${backupName}“ im Ordner config gesichert.`
    : 'Die ursprüngliche Datei konnte nicht gesichert werden und bleibt bis zum nächsten Speichern unverändert.';
  const description =
    problem.kind === 'unreadable'
      ? `settings.json konnte nicht gelesen werden (kein gültiges JSON-Objekt). Alle Einstellungen wurden auf die Standardwerte gesetzt. ${backupText}`
      : `Diese Werte in settings.json waren ungültig und wurden auf den Standard gesetzt: ${problem.fields.join(', ')}. Alle anderen Einstellungen bleiben erhalten. ${backupText}`;
  return {
    title: problem.kind === 'unreadable' ? 'Einstellungen zurückgesetzt' : 'Ungültige Einstellungen zurückgesetzt',
    description,
    type: 'system',
    priority: 'high',
    proposedActions: [{ label: 'Einstellungen öffnen', kind: 'navigate', target: '/settings/' }],
    dedupeKey: `settings-load:${backupName ?? Date.now()}`,
  };
}

/** Non-secret application configuration (config/settings.json). API keys are NOT stored here. */
export class SettingsService {
  private current: Settings;
  private loadProblem: SettingsLoadProblem | null = null;

  constructor(
    private readonly file: string,
    private readonly defaultArchiveRoot: string,
    private readonly events?: EventBus,
  ) {
    this.current = this.load();
  }

  /**
   * Returns the problem found while loading settings.json (once) and forgets it.
   * The service is created before the database, so the composition root turns this into a notification later.
   */
  takeLoadProblem(): SettingsLoadProblem | null {
    const problem = this.loadProblem;
    this.loadProblem = null;
    return problem;
  }

  /** Saves the original file next to it (`settings.json.<suffix>-<time>`); returns the backup path or null. */
  private backup(suffix: string, move: boolean): string | null {
    const target = `${this.file}.${suffix}-${Date.now()}`;
    try {
      if (move) fs.renameSync(this.file, target);
      else fs.copyFileSync(this.file, target, fs.constants.COPYFILE_EXCL);
      return target;
    } catch {
      return null;
    }
  }

  private load(): Settings {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') raw = {};
    }
    let settings: Settings;
    let persistRepaired = false;
    if (!isPlainObject(raw)) {
      // back up the broken file instead of silently overwriting it
      const backupFile = this.backup('corrupt', true);
      this.loadProblem = { kind: 'unreadable', fields: [], backupFile };
      settings = Settings.parse({});
    } else {
      const { settings: repaired, invalidFields } = repairSettings(raw);
      settings = repaired;
      if (invalidFields.length) {
        const backupFile = this.backup('invalid', false);
        this.loadProblem = { kind: 'invalid', fields: invalidFields, backupFile };
        // Only write the repaired file once the original is safe; otherwise keep it untouched until the next save.
        persistRepaired = backupFile !== null;
      }
    }
    if (!settings.archiveRoot) settings.archiveRoot = this.defaultArchiveRoot;
    if (persistRepaired || !fs.existsSync(this.file)) this.persist(settings);
    return settings;
  }

  private persist(settings: Settings): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  get(): Settings {
    return structuredClone(this.current);
  }

  update(patchInput: unknown): Settings {
    const patch = SettingsPatch.parse(patchInput);
    const next: Record<string, unknown> = { ...this.current };
    for (const [key, value] of Object.entries(patch)) {
      // eslint-disable-next-line sonarjs/different-types-comparison -- defensive: the patch arrives as parsed JSON via IPC
      if (value === undefined) continue;
      const prev = (this.current as Record<string, unknown>)[key];
      // eslint-disable-next-line sonarjs/different-types-comparison -- defensive: the patch arrives as parsed JSON via IPC
      const isSection = value !== null && typeof value === 'object' && !Array.isArray(value) && typeof prev === 'object';
      next[key] = isSection ? { ...(prev as object), ...definedFields(value) } : value;
    }
    const parsed = Settings.safeParse(next);
    if (!parsed.success) throw validationError('Ungültige Einstellungen.', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const settings = parsed.data;
    if (patch.llm?.baseUrl !== undefined) {
      const url = settings.llm.baseUrl.trim();
      if (url) {
        try {
          const u = new URL(url);
          if (!/^https?:$/.test(u.protocol)) throw new Error('protocol');
        } catch {
          throw validationError('Die Base URL muss mit http:// oder https:// beginnen.');
        }
      }
      // eslint-disable-next-line sonarjs/super-linear-regex -- base URL, length is bounded
      settings.llm.baseUrl = url.replace(/\/+$/, '');
    }
    if (patch.archiveRoot !== undefined) {
      if (!settings.archiveRoot.trim()) settings.archiveRoot = this.defaultArchiveRoot;
      settings.archiveRoot = path.resolve(settings.archiveRoot);
      try {
        fs.mkdirSync(settings.archiveRoot, { recursive: true });
        fs.accessSync(settings.archiveRoot, fs.constants.W_OK);
      } catch (err) {
        throw new AppError('filesystem_error', 'Der Archivpfad ist nicht beschreibbar.', { cause: err, details: settings.archiveRoot });
      }
    }
    this.persist(settings);
    this.current = settings;
    this.events?.changed('settings');
    return this.get();
  }
}
