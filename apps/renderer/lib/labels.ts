import type {
  ArchiveMode,
  BackgroundLimitKind,
  DecisionStatus,
  DocumentStatus,
  InsightKind,
  JobStatus,
  LlmStatus,
  LlmTestResult,
  NotificationType,
  ReasoningEffort,
  RelationStatus,
  ScanFileStatus,
} from '@archivist/shared';

export const INSIGHT_KIND_LABELS: Record<InsightKind, string> = {
  assignment: 'Zuordnungsvorschläge',
  archive_proposal: 'Archivierungsvorschläge',
  contradiction: 'Widersprüche',
  open_item: 'Offene Punkte',
  incomplete_decision: 'Unvollständige Entscheidungen',
  duplicate: 'Mögliche Duplikate',
  similar_topics: 'Ähnliche Themen',
  similar_entities: 'Mögliche Dubletten',
  orphan_document: 'Dokumente ohne Zuordnung',
  outdated_info: 'Veraltete Informationen',
  missing_metadata: 'Fehlende Angaben',
  external_file: 'Dateien außerhalb des Archivs',
  possibly_superseded: 'Möglicherweise überholt',
  decision_expired: 'Gültigkeit abgelaufen',
  misplaced_file: 'Falsch abgelegte Dateien',
  scattered_documents: 'Verstreut abgelegte Dokumente',
  low_confidence_relation: 'Unsichere Verknüpfungen',
  topic_project_name: 'Thema oder Projekt?',
  persons_merged: 'Zusammengeführte Personen',
  unclear_person: 'Unklare Personen',
  learned_rule: 'Gelernte Regel',
  topic_cluster: 'Vorschläge für neue Themen',
  orphan_entries: 'Einträge ohne Verknüpfung',
};

export { DECISION_STATUS_LABELS } from '@archivist/shared';

/** What a decision status means, in one sentence. */
export const DECISION_STATUS_HINTS: Record<DecisionStatus, string> = {
  draft: 'Es fehlen noch Angaben.',
  active: 'So von dir angegeben, aber noch nicht eigens bestätigt.',
  confirmed: 'Von dir geprüft und bestätigt.',
  unclear: 'Noch nicht geprüft oder unsicher – gilt nicht als gültig.',
  superseded: 'Eine neuere Entscheidung ersetzt sie.',
  revoked: 'Du hast sie widerrufen.',
};

export { OPEN_ITEM_STATUS_LABELS } from '@archivist/shared';

export const LLM_STATUS_LABELS: Record<LlmStatus, string> = {
  local_only: 'nur lokal gescannt',
  pending: 'zur KI-Analyse vorgesehen',
  analyzed: 'per KI analysiert',
  excluded: 'von externer Analyse ausgeschlossen',
};

export const SCAN_STATUS_LABELS: Record<ScanFileStatus, string> = {
  new: 'Neu',
  changed: 'Geändert',
  known: 'Bekannt',
  analyzed: 'Analysiert',
  archived: 'Archiviert',
  duplicate: 'Duplikat',
  excluded: 'Ausgeschlossen',
};

export const ARCHIVE_MODE_LABELS: Record<ArchiveMode, string> = {
  copy: 'Kopieren (Original bleibt)',
  move: 'Verschieben (Original wird entfernt)',
  index_only: 'Nur indexieren',
  ignore: 'Ignorieren',
};

export const ARCHIVE_MODE_SHORT: Record<ArchiveMode, string> = {
  copy: 'Kopieren',
  move: 'Verschieben',
  index_only: 'Nur indexieren',
  ignore: 'Ignorieren',
};

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  pending: 'Wartet',
  running: 'Läuft',
  succeeded: 'Fertig',
  failed: 'Fehlgeschlagen',
  cancelled: 'Abgebrochen',
};

export const RELATION_STATUS_LABELS: Record<RelationStatus, string> = {
  proposed: 'Vorgeschlagen',
  confirmed: 'Bestätigt',
  rejected: 'Abgelehnt',
  outdated: 'Veraltet',
};

export { RELATION_TYPE_LABELS } from '@archivist/shared';

export const NOTIFICATION_TYPE_LABELS: Record<NotificationType, string> = {
  open_item_due: 'Fälliger Punkt',
  open_item_overdue: 'Überfälliger Punkt',
  open_item_no_owner: 'Ohne Verantwortlichen',
  open_item_no_due: 'Ohne Termin',
  contradiction: 'Widerspruch',
  assignment_proposal: 'Zuordnung',
  incomplete_decision: 'Unvollständige Entscheidung',
  duplicate: 'Duplikat',
  consistency_done: 'Archivprüfung',
  import_failed: 'Import fehlgeschlagen',
  scan_new_files: 'Neue Dateien',
  scan_done: 'Suche beendet',
  scan_partial: 'Suche teilweise',
  file_changed: 'Datei geändert',
  external_duplicate: 'Duplikat außerhalb',
  external_related: 'Passende Datei',
  file_has_decision: 'Entscheidung in Datei',
  file_has_open_item: 'Offener Punkt in Datei',
  reminder: 'Erinnerung',
  classification_ready: 'Analyse fertig',
  system: 'System',
  agent_run: 'Hintergrund-Agent',
  deadline_watch: 'Fristen-Wächter',
  weekly_review: 'Wochenrückblick',
};

export const SUPPORTED_TYPES_TEXT = 'pdf, docx, pptx, xlsx, txt, md, eml, png, jpg, jpeg';

const structuredFailed = (test: LlmTestResult) => test.ok && test.structured?.ok === false;

export const connectionTone = (test: LlmTestResult) => (!test.ok ? 'danger' : structuredFailed(test) ? 'warning' : 'info');

export const connectionTitle = (test: LlmTestResult) =>
  !test.ok ? 'Verbindung fehlgeschlagen' : structuredFailed(test) ? 'Verbindung steht, strukturierte Antworten fehlgeschlagen' : 'Verbindung erfolgreich';

export const DOCUMENT_STATUS_LABELS: Record<DocumentStatus, string> = {
  staged: 'Wartet auf Analyse',
  analyzing: 'Wird analysiert',
  proposed: 'Vorschlag liegt in der Inbox',
  archived: 'Archiviert',
  indexed_only: 'Nur indexiert',
  ignored: 'Ignoriert',
  failed: 'Fehlgeschlagen',
  quarantined: 'In Quarantäne',
};

export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: 'keine (wird gesendet)',
  minimal: 'minimal',
  low: 'niedrig',
  medium: 'mittel',
  high: 'hoch',
  xhigh: 'sehr hoch',
  max: 'maximal',
};

/** Background tasks with limits of their own. */
export const BACKGROUND_KIND_LABELS: Record<BackgroundLimitKind, string> = {
  inbox: 'Neue Dateien einsortieren',
  archive_check: 'Archivprüfung auswerten',
  links: 'Verknüpfungen vorschlagen',
  workflow: 'Eigene Abläufe (geplant)',
};

/** Index 0 is Sunday, as in the settings. */
export const WEEKDAY_NAMES = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
