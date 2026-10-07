import { OCR_LANGUAGE_CHOICES } from '@archivist/shared';
import { formatNumber } from './format';
import { BACKGROUND_KIND_LABELS, REASONING_EFFORT_LABELS, THEME_LABELS, WEEKDAY_NAMES } from './labels';

const PRICE_UNIT = '(US$ je 1 Mio. Tokens)';

/** Every leaf path of the settings as the audit log writes it; `*` is the key of a record entry, `{}` in the label shows it. */
const SETTING_LABELS: Record<string, string> = {
  setupCompleted: 'Einrichtung abgeschlossen',
  'profile.name': 'Dein Name',
  'profile.nicknames': 'Deine Spitznamen',
  language: 'Sprache',
  'llm.baseUrl': 'Adresse der KI (Base URL)',
  'llm.model': 'Modellname',
  'llm.reasoningEffort': 'Denktiefe der KI',
  'llm.timeoutMs': 'Zeitlimit der KI (Millisekunden)',
  'llm.maxInputChars': 'Maximale Eingabegröße der KI (Zeichen)',
  'llm.embeddingModel': 'Embedding-Modell',
  'llm.dailyTokenCap': 'Tageslimit (Tokens)',
  archiveRoot: 'Archivordner',
  'scan.enabled': 'Dokumentensuche',
  'scan.onStartup': 'Dokumentensuche beim Start',
  'scan.periodic': 'Regelmäßige Dokumentensuche',
  'scan.intervalMinutes': 'Suchintervall (Minuten)',
  'scan.maxFileSizeMb': 'Höchste Dateigröße der Suche (MB)',
  'scan.allowedExtensions': 'Gesuchte Dateitypen',
  'scan.autoAnalyze': 'Neue Dateien automatisch analysieren',
  'privacy.llmMode': 'Datenschutzmodus',
  'privacy.neverAnalyzeDirs': 'Nie analysierte Ordner',
  'privacy.neverAnalyzeExtensions': 'Nie analysierte Dateitypen',
  'privacy.neverAnalyzeFiles': 'Nie analysierte Dateien',
  'privacy.maskPersonalData': 'Persönliche Daten maskieren',
  'notifications.desktop': 'Desktop-Benachrichtigungen',
  'notifications.reminderTime': 'Uhrzeit für Erinnerungen ohne Uhrzeit',
  'logs.level': 'Detailgrad der Protokolle',
  'logs.retentionDays': 'Aufbewahrung der Protokolle (Tage)',
  'backups.keep': 'Anzahl aufbewahrter Backups',
  'backups.autoOnStartup': 'Beim Start automatisch sichern',
  'backups.includeArchive': 'Automatische Backups enthalten das Archiv',
  'consistency.onStartup': 'Archivprüfung beim Start',
  'consistency.intervalHours': 'Intervall der Archivprüfung (Stunden)',
  'consistency.staleOpenItemDays': 'Offene Punkte gelten als vergessen nach (Tagen)',
  'consistency.dueSoonDays': 'Offene Punkte gelten als „Bald fällig“ (Tage vor der Frist)',
  'consistency.autoMergePersons': 'Personen-Dubletten automatisch zusammenführen',
  'ocr.enabled': 'Texterkennung (OCR)',
  'ocr.languages': 'Texterkennung (OCR): Sprachen',
  'agent.enabled': 'Agentenmodus',
  'agent.mode': 'Modus des Agenten',
  'agent.massActionThreshold': 'Massenaktion ab … Einträgen',
  'agent.adapter': 'Schnittstelle des Agenten',
  'agent.effort': 'Denktiefe des Agenten',
  'agent.chatLimits.maxRounds': 'Grenzen im Chat: Runden',
  'agent.chatLimits.maxTokens': 'Grenzen im Chat: Tokens pro Lauf',
  'agent.chatLimits.timeoutMs': 'Grenzen im Chat: Zeitlimit (Millisekunden)',
  'agent.backgroundLimits.maxRounds': 'Grenzen im Hintergrund: Runden',
  'agent.backgroundLimits.maxTokens': 'Grenzen im Hintergrund: Tokens pro Lauf',
  'agent.backgroundLimits.timeoutMs': 'Grenzen im Hintergrund: Zeitlimit (Millisekunden)',
  'agent.backgroundKindLimits.*.maxRounds': 'Eigene Grenzen für „{}“: Runden',
  'agent.backgroundKindLimits.*.maxTokens': 'Eigene Grenzen für „{}“: Tokens pro Lauf',
  'agent.backgroundKindLimits.*.timeoutMs': 'Eigene Grenzen für „{}“: Zeitlimit (Millisekunden)',
  'agent.maxRetries': 'Wiederholungen pro Anfrage',
  'agent.prices.*.input': `Eigener Preis für {}: Eingabe ${PRICE_UNIT}`,
  'agent.prices.*.output': `Eigener Preis für {}: Ausgabe ${PRICE_UNIT}`,
  'agent.prices.*.cacheRead': `Eigener Preis für {}: Cache lesen ${PRICE_UNIT}`,
  'agent.prices.*.cacheWrite': `Eigener Preis für {}: Cache schreiben ${PRICE_UNIT}`,
  'agent.background.inbox': 'Eingang im Hintergrund sortieren',
  'agent.background.archiveCheck': 'Archivprüfung im Hintergrund auswerten',
  'agent.background.links': 'Verknüpfungen im Hintergrund vorschlagen',
  'agent.background.nightlyHour': 'Nachtlauf',
  'agent.background.deadlineWatch': 'Fristen-Wächter',
  'agent.background.deadlineLeadDays': 'Vorlauf des Fristen-Wächters (Tage)',
  'agent.background.weeklyReview': 'Wochenrückblick',
  'agent.background.weeklyReviewDay': 'Wochentag des Rückblicks',
  'agent.learning': 'Gelerntes verwenden',
  'agent.webSearch': 'Websuche im Chat',
  'speech.model': 'Modell der Spracheingabe',
  'appearance.theme': 'Farbschema',
  'links.autoPropose': 'Verknüpfungen automatisch vorschlagen',
  'links.maxProposalsPerEntry': 'Höchstens offene Verknüpfungsvorschläge je Eintrag',
};

/** How the key of a record entry is shown; keys without an entry (model names) are the user's own words. */
const RECORD_KEY_LABELS: Record<string, Record<string, string>> = {
  'agent.backgroundKindLimits': BACKGROUND_KIND_LABELS,
};

const labelsOf = (labels: Record<string, string>) => (value: unknown) => labels[String(value)];

/** Settings whose values are codes; `undefined` falls back to the plain value. */
const VALUE_TEXTS: Record<string, (value: unknown) => string | undefined> = {
  'llm.reasoningEffort': (value) => (value === null ? 'Standard des Modells' : labelsOf(REASONING_EFFORT_LABELS)(value)),
  'llm.dailyTokenCap': (value) => (value === null ? 'kein Limit' : undefined),
  'agent.effort': labelsOf(REASONING_EFFORT_LABELS),
  'privacy.llmMode': labelsOf({ auto: 'Automatisch analysieren', confirm: 'Vor jeder externen Analyse fragen', local_only: 'Nur lokal' }),
  'agent.mode': labelsOf({ auto: 'Auto', ask: 'Fragen' }),
  'agent.adapter': labelsOf({ auto: 'Automatisch', anthropic: 'Claude (Anthropic)', openai: 'OpenAI-kompatibel' }),
  'appearance.theme': labelsOf(THEME_LABELS),
  'speech.model': labelsOf({ small: 'small (schnell, Standard)', medium: 'medium', turbo: 'turbo' }),
  'logs.level': labelsOf({ error: 'Nur Fehler', warn: 'Warnungen und Fehler', info: 'Normal', debug: 'Ausführlich (Fehlersuche)' }),
  'agent.background.nightlyHour': (value) => (typeof value === 'number' ? `um ${String(value).padStart(2, '0')}:00 Uhr` : 'aus'),
  'agent.background.weeklyReviewDay': (value) => WEEKDAY_NAMES[Number(value)],
  'ocr.languages': (value) =>
    String(value)
      .split('+')
      .map((code) => OCR_LANGUAGE_CHOICES.find((choice) => choice.code === code)?.label ?? code)
      .join(', '),
};

const MAX_VALUE_LENGTH = 140;

/** The labelled pattern a concrete path matches and the record key it holds (empty without one). */
function matchingPattern(path: string): { pattern: string; recordKey: string } | undefined {
  if (path in SETTING_LABELS) return { pattern: path, recordKey: '' };
  const segments = path.split('.');
  for (const pattern of Object.keys(SETTING_LABELS)) {
    const wildcard = pattern.split('.').indexOf('*');
    if (wildcard < 0 || pattern.split('.').length !== segments.length) continue;
    const candidate = [...segments.slice(0, wildcard), '*', ...segments.slice(wildcard + 1)].join('.');
    if (candidate === pattern) return { pattern, recordKey: segments[wildcard]! };
  }
  return undefined;
}

/** The setting in words; an unknown path stays as it is (a unit test covers every path of the settings schema). */
export function settingLabel(path: string): string {
  const match = matchingPattern(path);
  if (!match) return path;
  const recordPath = match.pattern.slice(0, match.pattern.indexOf('.*'));
  const recordKey = RECORD_KEY_LABELS[recordPath]?.[match.recordKey] ?? match.recordKey;
  return SETTING_LABELS[match.pattern]!.replace('{}', recordKey);
}

function plainValueText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '–';
  if (typeof value === 'boolean') return value ? 'an' : 'aus';
  if (typeof value === 'number') return formatNumber(value);
  if (Array.isArray(value)) return value.length === 0 ? '–' : value.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(', ');
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** A value of the setting in words: codes by their German name, switches as „an“/„aus“. */
export function settingValueText(path: string, value: unknown): string {
  const pattern = matchingPattern(path)?.pattern ?? path;
  const text = VALUE_TEXTS[pattern]?.(value) ?? plainValueText(value);
  return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)} …` : text;
}
