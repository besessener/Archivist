import type {
  ArchiveMode,
  DecisionStatus,
  InsightKind,
  JobStatus,
  LlmStatus,
  NotificationType,
  OpenItemStatus,
  RelationStatus,
  RelationType,
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
  orphan_document: 'Dokumente ohne Zuordnung',
  outdated_info: 'Veraltete Informationen',
  missing_metadata: 'Fehlende Angaben',
  external_file: 'Dateien außerhalb des Archivs',
  possibly_superseded: 'Möglicherweise überholt',
  misplaced_file: 'Falsch abgelegte Dateien',
  low_confidence_relation: 'Unsichere Verknüpfungen',
};

export const DECISION_STATUS_LABELS: Record<DecisionStatus, string> = {
  draft: 'Entwurf',
  confirmed: 'Bestätigt',
  active: 'Gültig',
  superseded: 'Ersetzt',
  revoked: 'Widerrufen',
  unclear: 'Unklar',
};

export const OPEN_ITEM_STATUS_LABELS: Record<OpenItemStatus, string> = {
  open: 'Offen',
  waiting: 'Wartet',
  blocked: 'Blockiert',
  resolved: 'Erledigt',
  dismissed: 'Verworfen',
};

export const LLM_STATUS_LABELS: Record<LlmStatus, string> = {
  local_only: 'nur lokal gescannt',
  pending: 'zur LLM-Analyse vorgesehen',
  analyzed: 'per LLM analysiert',
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

export const RELATION_TYPE_LABELS: Record<RelationType, string> = {
  belongs_to: 'gehört zu',
  relates_to: 'hängt zusammen mit',
  supports: 'unterstützt',
  contradicts: 'widerspricht',
  participated_in: 'beteiligt an',
  concerns: 'betrifft',
  affects: 'wirkt auf',
  supersedes: 'ersetzt',
  blocks: 'blockiert',
  results_from: 'ergibt sich aus',
  produced: 'hat erzeugt',
  duplicate_of: 'Duplikat von',
  related_to: 'verwandt mit',
};

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
};

export const SUPPORTED_TYPES_TEXT = 'pdf, docx, pptx, xlsx, txt, md, eml, png, jpg, jpeg';
