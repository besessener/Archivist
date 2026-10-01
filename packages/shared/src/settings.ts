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

export const Settings = z.object({
  setupCompleted: z.boolean().default(false),
  language: z.literal('de').default('de'),
  llm: LlmSettings.default(() => LlmSettings.parse({})),
  archiveRoot: z.string().default(''),
  scan: ScanSettings.default(() => ScanSettings.parse({})),
  privacy: PrivacySettings.default(() => PrivacySettings.parse({})),
  notifications: z.object({ desktop: z.boolean().default(false) }).default({ desktop: false }),
  logs: LogSettings.default(() => LogSettings.parse({})),
  backups: BackupSettings.default(() => BackupSettings.parse({})),
  consistency: ConsistencySettings.default(() => ConsistencySettings.parse({})),
  ocr: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
});
export type Settings = z.infer<typeof Settings>;

/** Teilweise Aktualisierung (pro Bereich flach zusammengeführt). */
export const SettingsPatch = z.object({
  setupCompleted: z.boolean().optional(),
  llm: LlmSettings.partial().optional(),
  archiveRoot: z.string().optional(),
  scan: ScanSettings.partial().optional(),
  privacy: PrivacySettings.partial().optional(),
  notifications: z.object({ desktop: z.boolean() }).partial().optional(),
  logs: LogSettings.partial().optional(),
  backups: BackupSettings.partial().optional(),
  consistency: ConsistencySettings.partial().optional(),
  ocr: z.object({ enabled: z.boolean() }).partial().optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatch>;
