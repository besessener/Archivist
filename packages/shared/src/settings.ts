import { z } from 'zod';
import { patchSchema } from './common';
import { LOCAL_TIME } from './dates';
import { SUPPORTED_EXTENSIONS } from './documents';
import { AgentSettings, BackgroundAgentSettings } from './agent';
import { SpeechModelName } from './speech';

export const ReasoningEffort = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export type ReasoningEffort = z.infer<typeof ReasoningEffort>;

export const LlmSettings = z.object({
  baseUrl: z.string().default(''),
  model: z.string().default(''),
  reasoningEffort: ReasoningEffort.nullable().default(null),
  timeoutMs: z.number().int().min(1000).max(600000).default(60000),
  maxInputChars: z.number().int().min(500).max(2000000).default(24000),
  /** optional embedding model (/embeddings). Empty = local vectors. */
  embeddingModel: z.string().default(''),
  /** Base URL of /embeddings; empty = the base URL of the LLM. */
  embeddingBaseUrl: z.string().default(''),
  /** Daily token limit (input, cache reads and output); null = no limit. Background jobs pause when it is reached, the chat asks first. */
  dailyTokenCap: z.number().int().min(1000).max(10_000_000_000).nullable().default(null),
});

export const ScanSettings = z.object({
  /** The local document search is disabled by default. */
  enabled: z.boolean().default(false),
  onStartup: z.boolean().default(false),
  periodic: z.boolean().default(false),
  intervalMinutes: z.number().int().min(5).max(10080).default(60),
  maxFileSizeMb: z.number().min(0.1).max(2048).default(50),
  allowedExtensions: z.array(z.string()).default([...SUPPORTED_EXTENSIONS]),
  autoAnalyze: z.boolean().default(false),
});

export const PrivacySettings = z.object({
  /** auto: analyze content automatically, confirm: confirm before every external analysis, local_only: never external */
  llmMode: z.enum(['auto', 'confirm', 'local_only']).default('confirm'),
  neverAnalyzeDirs: z.array(z.string()).default([]),
  neverAnalyzeExtensions: z.array(z.string()).default([]),
  neverAnalyzeFiles: z.array(z.string()).default([]),
  /** Replaces IBAN, card numbers, tax and social security IDs and PINs by placeholders before they leave the machine or reach the log (#203). */
  maskPersonalData: z.boolean().default(true),
});

const LogSettings = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  retentionDays: z.number().int().min(1).default(30),
});
const BackupSettings = z.object({
  keep: z.number().int().min(1).default(3),
  autoOnStartup: z.boolean().default(false),
  includeArchive: z.boolean().default(false),
});
const ConsistencySettings = z.object({
  onStartup: z.boolean().default(true),
  intervalHours: z.number().min(0).default(24),
  staleOpenItemDays: z.number().int().min(1).default(30),
  /** Open items due within this many days count as „Bald fällig“. */
  dueSoonDays: z.number().int().min(1).max(365).default(7),
  /** Merge unambiguous person duplicates („Monika Lor-Zade (Chefin)“ = „Lor-Zade, Monika“) without asking. */
  autoMergePersons: z.boolean().default(true),
});

/** Link proposals of the fixed link methods (Epic #269). */
export const LinkSettings = z.object({
  /** Propose links automatically: similar entries (#271) and entries from the same message or document (#272). */
  autoPropose: z.boolean().default(true),
  /** At most this many open similarity proposals per entry (#271). */
  maxProposalsPerEntry: z.number().int().min(1).max(10).default(3),
});

/** Who uses Archivist? Name and nicknames help to assign „ich/mir/mich“ and mentions of the user's own person. */
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

/** Languages whose Tesseract data ships with the app (@tesseract.js-data/*); the settings offer exactly these, in this order. */
export const OCR_LANGUAGE_CHOICES = [
  { code: 'deu', label: 'Deutsch' },
  { code: 'eng', label: 'Englisch' },
] as const;

const OcrSettings = z.object({
  enabled: z.boolean().default(true),
  languages: z.string().refine(isOcrLanguageList, { message: 'Ungültige OCR-Sprachcodes (Beispiel: deu+eng oder deu+chi_sim).' }).default('deu+eng'),
});

const SpeechSettings = z.object({
  /** Whisper model of the speech input in the chat; larger ones recognise better and take longer and more space. */
  model: SpeechModelName.default('small'),
});

/** Colour scheme of the window; `system` follows the operating system. */
export const ThemeChoice = z.enum(['system', 'light', 'dark']);
export type ThemeChoice = z.infer<typeof ThemeChoice>;

const AppearanceSettings = z.object({
  theme: ThemeChoice.default('system'),
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
  agent: AgentSettings.default(() => AgentSettings.parse({})),
  links: LinkSettings.default(() => LinkSettings.parse({})),
  speech: SpeechSettings.default(() => SpeechSettings.parse({})),
  appearance: AppearanceSettings.default(() => AppearanceSettings.parse({})),
});
export type Settings = z.infer<typeof Settings>;

/** Partial update (merged shallowly per section). Deliberately contains no defaults. */
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
  agent: patchSchema(AgentSettings)
    .extend({ background: patchSchema(BackgroundAgentSettings).optional() })
    .optional(),
  links: patchSchema(LinkSettings).optional(),
  speech: patchSchema(SpeechSettings).optional(),
  appearance: patchSchema(AppearanceSettings).optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatch>;
