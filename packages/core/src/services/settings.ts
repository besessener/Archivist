import fs from 'node:fs';
import path from 'node:path';
import { Settings, SettingsPatch } from '@archivist/shared';
import type { EventBus } from '../context';
import { AppError, validationError } from '../util/errors';

/** Nicht geheime Anwendungskonfiguration (config/settings.json). API-Keys liegen NICHT hier. */
export class SettingsService {
  private current: Settings;

  constructor(
    private readonly file: string,
    private readonly defaultArchiveRoot: string,
    private readonly events?: EventBus,
  ) {
    this.current = this.load();
  }

  private load(): Settings {
    let raw: unknown = {};
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // defekte Datei sichern, statt sie stillschweigend zu überschreiben
        try {
          fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
        } catch {
          /* ignorieren */
        }
      }
    }
    const parsed = Settings.safeParse(raw);
    const settings = parsed.success ? parsed.data : Settings.parse({});
    if (!settings.archiveRoot) settings.archiveRoot = this.defaultArchiveRoot;
    if (!fs.existsSync(this.file)) this.persist(settings);
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
      if (value === undefined) continue;
      const prev = (this.current as Record<string, unknown>)[key];
      next[key] = value !== null && typeof value === 'object' && !Array.isArray(value) && typeof prev === 'object' ? { ...(prev as object), ...value } : value;
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
