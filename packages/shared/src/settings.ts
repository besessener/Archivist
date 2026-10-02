import { z } from 'zod';
import { patchSchema } from './common';
import { LOCAL_TIME } from './dates';
import { SUPPORTED_EXTENSIONS } from './domain';

export const ReasoningEffort = z.enum(['none', 'minimal', 'low', 'medium', 'high']);

export const LlmSettings = z.object({
  baseUrl: z.string().default(''),
  model: z.string().default(''),
  reasoningEffort: ReasoningEffort.nullable().default(null),
  timeoutMs: z.number().int().min(1000).max(600000).default(60000),
  maxInputChars: z.number().int().min(500).max(2000000).default(24000),
  /** optionales Embedding-Modell (/embeddings). Leer = lokale Vektoren. */
  embeddingModel: z.string().default(''),
});

export const ScanSettings = z.object({
  /** Lokale Dokumentensuche ist standardmäßig deaktiviert. */
  enabled: z.boolean().default(false),
  onStartup: z.boolean().default(false),
  periodic: z.boolean().default(false),
  intervalMinutes: z.number().int().min(5).max(10080).default(60),
  maxFileSizeMb: z.number().min(0.1).max(2048).default(50),
  allowedExtensions: z.array(z.string()).default([...SUPPORTED_EXTENSIONS]),
  autoAnalyze: z.boolean().default(false),
});

export const PrivacySettings = z.object({
  /** auto: Inhalte automatisch analysieren, confirm: vor jeder externen Analyse bestätigen, local_only: nie extern */
  llmMode: z.enum(['auto', 'confirm', 'local_only']).default('confirm'),
  neverAnalyzeDirs: z.array(z.string()).default([]),
  neverAnalyzeExtensions: z.array(z.string()).default([]),
  neverAnalyzeFiles: z.array(z.string()).default([]),
});

const LogSettings = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  retentionDays: z.number().int().min(1).default(30),
});
const BackupSettings = z.object({
  keep: z.number().int().min(1).default(10),
  autoOnStartup: z.boolean().default(false),
  includeArchive: z.boolean().default(false),
});
const ConsistencySettings = z.object({
  onStartup: z.boolean().default(true),
  intervalHours: z.number().min(0).default(24),
  staleOpenItemDays: z.number().int().min(1).default(30),
});

/** Wer benutzt Archivist? Name und Spitznamen helfen, „ich/mir/mich“ und Erwähnungen der eigenen Person zuzuordnen. */
export const ProfileSettings = z.object({
  name: z.string().max(200).default(''),
  nicknames: z.array(z.string().max(100)).max(20).default([]),
});

const NotificationSettings = z.object({
  desktop: z.boolean().default(false),
  /** Local time of day at which reminders without a time (date only) fire. */
  reminderTime: z.string().regex(LOCAL_TIME, 'Erwartet eine Uhrzeit im Format HH:MM.').default('08:00'),
});

/** One Tesseract language code, e.g. `deu` or `chi_sim` (same rule the OCR module applies). */
export const OCR_LANGUAGE_CODE = /^[a-z]{3}(?:_[a-z]+)?$/;

/** `true` if `value` is a `+`-separated list of Tesseract language codes, e.g. `deu+chi_sim`. */
export function isOcrLanguageList(value: string): boolean {
  return value.split('+').every((code) => OCR_LANGUAGE_CODE.test(code));
}

const OcrSettings = z.object({
  enabled: z.boolean().default(true),
  languages: z.string().refine(isOcrLanguageList, { message: 'Ungültige OCR-Sprachcodes (Beispiel: deu+eng oder deu+chi_sim).' }).default('deu+eng'),
});

export const Settings = z.object({
  setupCompleted: z.boolean().default(false),
  profile: ProfileSettings.default(() => ProfileSettings.parse({})),
  language: z.literal('de').default('de'),
  llm: LlmSettings.default(() => LlmSettings.parse({})),
  archiveRoot: z.string().default(''),
  scan: ScanSettings.default(() => ScanSettings.parse({})),
  privacy: PrivacySettings.default(() => PrivacySettings.parse({})),
  notifications: NotificationSettings.default(() => NotificationSettings.parse({})),
  logs: LogSettings.default(() => LogSettings.parse({})),
  backups: BackupSettings.default(() => BackupSettings.parse({})),
  consistency: ConsistencySettings.default(() => ConsistencySettings.parse({})),
  ocr: OcrSettings.default(() => OcrSettings.parse({})),
});
export type Settings = z.infer<typeof Settings>;

/** Teilweise Aktualisierung (pro Bereich flach zusammengeführt). Enthält bewusst keine Defaults. */
export const SettingsPatch = z.object({
  setupCompleted: z.boolean().optional(),
  profile: patchSchema(ProfileSettings).optional(),
  llm: patchSchema(LlmSettings).optional(),
  archiveRoot: z.string().optional(),
  scan: patchSchema(ScanSettings).optional(),
  privacy: patchSchema(PrivacySettings).optional(),
  notifications: patchSchema(NotificationSettings).optional(),
  logs: patchSchema(LogSettings).optional(),
  backups: patchSchema(BackupSettings).optional(),
  consistency: patchSchema(ConsistencySettings).optional(),
  ocr: patchSchema(OcrSettings).optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatch>;
