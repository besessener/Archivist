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

/** Nested sub-sections of a section (e.g. `agent.background`) are merged field by field as well; records like `agent.prices` are replaced. */
const NESTED_SECTIONS = new Set(['background']);
function mergeSection(prev: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...prev };
  for (const [k, v] of Object.entries(patch))
    out[k] = NESTED_SECTIONS.has(k) && isPlainObject(v) && isPlainObject(prev[k]) ? { ...prev[k], ...definedFields(v) } : v;
  return out;
}

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

/** Removes the field an issue points at (a section field or a top-level key); returns its path, or null if absent. */
function removeIssueField(draft: Record<string, unknown>, issuePath: readonly PropertyKey[]): string | null {
  const [key, field] = issuePath;
  if (typeof key !== 'string') return null;
  const section = draft[key];
  if (SECTION_KEYS.has(key) && typeof field === 'string' && isPlainObject(section)) {
    if (!(field in section)) return null;
    delete section[field];
    return `${key}.${field}`;
  }
  if (!(key in draft)) return null;
  delete draft[key];
  return key;
}

/** Validates raw settings field by field: only invalid fields fall back to their default; returns them as paths. */
export function repairSettings(raw: Record<string, unknown>): { settings: Settings; invalidFields: string[] } {
  const draft = structuredClone(raw);
  const invalid = new Set<string>();
  // Each round removes at least one offending field, so this ends after at most (number of fields) rounds.
  for (;;) {
    const parsed = Settings.safeParse(draft);
    if (parsed.success) return { settings: parsed.data, invalidFields: [...invalid] };
    const removed = parsed.error.issues.map((issue) => removeIssueField(draft, issue.path)).filter((field): field is string => field !== null);
    for (const field of removed) invalid.add(field);
    // Should not happen (e.g. a cross-field rule); fall back to the defaults instead of looping forever.
    if (!removed.length) return { settings: Settings.parse({}), invalidFields: [...invalid, ...Object.keys(draft)] };
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

export type SettingsServiceDeps = { file: string; defaultArchiveRoot: string; events?: EventBus };

/** Non-secret application configuration (config/settings.json). API keys are NOT stored here. */
export class SettingsService {
  private current: Settings;
  private loadProblem: SettingsLoadProblem | null = null;

  private readonly file: string;
  private readonly defaultArchiveRoot: string;
  private readonly events?: EventBus;

  constructor(deps: SettingsServiceDeps) {
    ({ file: this.file, defaultArchiveRoot: this.defaultArchiveRoot, events: this.events } = deps);
    this.current = this.load();
  }

  /** Returns the load problem once and forgets it; the composition root reports it once the database exists. */
  takeLoadProblem(): SettingsLoadProblem | null {
    const problem = this.loadProblem;
    this.loadProblem = null;
    return problem;
  }

  /** Saves the original file next to it (`settings.json.<suffix>-<time>`); returns the backup path or null. */
  private backup(suffix: 'corrupt' | 'invalid', mode: 'move' | 'copy'): string | null {
    const target = `${this.file}.${suffix}-${Date.now()}`;
    try {
      if (mode === 'move') fs.renameSync(this.file, target);
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
      const backupFile = this.backup('corrupt', 'move');
      this.loadProblem = { kind: 'unreadable', fields: [], backupFile };
      settings = Settings.parse({});
    } else {
      const { settings: repaired, invalidFields } = repairSettings(raw);
      settings = repaired;
      if (invalidFields.length) {
        const backupFile = this.backup('invalid', 'copy');
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
    const temporaryFile = `${this.file}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(settings, null, 2), 'utf8');
    fs.renameSync(temporaryFile, this.file);
  }

  get(): Settings {
    return structuredClone(this.current);
  }

  update(patchInput: unknown): Settings {
    const patch = SettingsPatch.parse(patchInput);
    const next: Record<string, unknown> = { ...this.current };
    for (const [key, value] of Object.entries(definedFields(patch))) {
      const prev = (this.current as Record<string, unknown>)[key];
      next[key] = isPlainObject(value) && typeof prev === 'object' ? mergeSection(prev as Record<string, unknown>, definedFields(value)) : value;
    }
    const parsed = Settings.safeParse(next);
    if (!parsed.success) throw validationError('Ungültige Einstellungen.', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const settings = parsed.data;
    if (patch.llm?.baseUrl !== undefined) settings.llm.baseUrl = checkedBaseUrl(settings.llm.baseUrl);
    if (patch.archiveRoot !== undefined) settings.archiveRoot = this.writableArchiveRoot(settings.archiveRoot);
    this.persist(settings);
    this.current = settings;
    this.events?.changed('settings');
    return this.get();
  }

  /** The absolute archive path; empty means the default. */
  resolveArchiveRoot(archiveRoot: string): string {
    return path.resolve(archiveRoot.trim() ? archiveRoot : this.defaultArchiveRoot);
  }

  /** The absolute archive path, created if missing and checked for write access. */
  private writableArchiveRoot(archiveRoot: string): string {
    const root = this.resolveArchiveRoot(archiveRoot);
    try {
      fs.mkdirSync(root, { recursive: true });
      fs.accessSync(root, fs.constants.W_OK);
    } catch (err) {
      throw new AppError('filesystem_error', 'Der Archivpfad ist nicht beschreibbar.', { cause: err, details: root });
    }
    return root;
  }
}

/** The trimmed base URL without trailing slashes; it must be http(s) unless empty. */
function checkedBaseUrl(baseUrl: string): string {
  let url = baseUrl.trim();
  if (url && !isHttpUrl(url)) throw validationError('Die Base URL muss mit http:// oder https:// beginnen.');
  while (url.endsWith('/')) url = url.slice(0, -1);
  return url;
}

function isHttpUrl(url: string): boolean {
  try {
    return /^https?:$/.test(new URL(url).protocol);
  } catch {
    return false;
  }
}
