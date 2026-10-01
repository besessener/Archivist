import { z } from 'zod';
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

const NotificationSettings = z.object({ desktop: z.boolean().default(false) });
const OcrSettings = z.object({
  enabled: z.boolean().default(true),
  languages: z
    .string()
    .regex(/^[a-z]{3}(\+[a-z]{3})*$/)
    .default('deu+eng'),
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

type WithoutDefault<T> = T extends z.ZodDefault<infer Inner> ? Inner : T;
type WithoutDefaults<Shape extends z.ZodRawShape> = { [K in keyof Shape]: WithoutDefault<Shape[K]> };

/**
 * Patch schema for one settings section: every field optional and WITHOUT `.default()`.
 * Zod 4 applies defaults even inside `.partial()` / `.optional()`, so `Section.partial()` would
 * fill in every missing field and the merge would reset the rest of the section (issue #55).
 * Defaults are applied only after merging, when the full `Settings` schema is parsed.
 */
function sectionPatch<Shape extends z.ZodRawShape>(section: z.ZodObject<Shape>) {
  const shape = Object.fromEntries(
    Object.entries(section.shape).map(([key, field]) => [key, field instanceof z.ZodDefault ? field.unwrap() : field]),
  ) as WithoutDefaults<Shape>;
  return z.object(shape).partial();
}

/** Teilweise Aktualisierung (pro Bereich flach zusammengeführt). Enthält bewusst keine Defaults. */
export const SettingsPatch = z.object({
  setupCompleted: z.boolean().optional(),
  profile: sectionPatch(ProfileSettings).optional(),
  llm: sectionPatch(LlmSettings).optional(),
  archiveRoot: z.string().optional(),
  scan: sectionPatch(ScanSettings).optional(),
  privacy: sectionPatch(PrivacySettings).optional(),
  notifications: sectionPatch(NotificationSettings).optional(),
  logs: sectionPatch(LogSettings).optional(),
  backups: sectionPatch(BackupSettings).optional(),
  consistency: sectionPatch(ConsistencySettings).optional(),
  ocr: sectionPatch(OcrSettings).optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatch>;
