import type { AuditEntry } from '@archivist/shared';
import { formatLongDate } from './format';
import { ARCHIVE_MODE_SHORT, RELATION_STATUS_LABELS } from './labels';
import { ENTITY_TYPE_LABELS } from './nav';

const ACTION_LABELS: Record<string, string> = {
  'decision.create': 'Entscheidung angelegt',
  'decision.update': 'Entscheidung bearbeitet',
  'decision.supersede': 'Entscheidung als ersetzt markiert',
  'decision.revoke': 'Entscheidung widerrufen',
  'decision.delete': 'Entscheidung gelöscht',
  'settings.change': 'Einstellung geändert',
  'document.import': 'Dokument importiert',
  'document.quarantine': 'Datei in Quarantäne gelegt',
  'document.releaseQuarantine': 'Datei aus der Quarantäne importiert',
  'document.assign': 'Dokument zugeordnet',
  'document.updateMetadata': 'Angaben zum Dokument bearbeitet',
  'document.bulkUpdate': 'Angaben zu mehreren Dokumenten bearbeitet',
  'document.refresh': 'Dokument neu eingelesen',
  'document.reread': 'Dokumenttext neu eingelesen',
  'document.llmExclusion': 'Externe Analyse eines Dokuments geändert',
  'document.ignore': 'Dokument ignoriert',
  'document.unignore': 'Dokument wieder aufgenommen',
  'document.trash': 'Dokument in den Papierkorb gelegt',
  'trash.empty': 'Papierkorb geleert',
  'archive.relocate': 'Archivdatei in einen anderen Ordner verschoben',
  'archive.rename': 'Archivdatei umbenannt',
  'archive.relink': 'Verschobene Archivdatei neu verknüpft',
  'archive.changeRoot': 'Archivordner gewechselt',
  'archive.migrateRoot': 'Archiv in einen anderen Ordner übertragen',
  'category.create': 'Ordner im Archiv angelegt',
  'category.removeEmpty': 'Leeren Archivordner entfernt',
  'backup.create': 'Sicherung erstellt',
  'backup.prune': 'Alte Sicherungen aufgeräumt',
  'backup.restore': 'Sicherung wiederhergestellt',
  'case.create': 'Vorgang angelegt',
  'case.assign': 'Eintrag einem Vorgang zugeordnet',
  'case.close': 'Vorgang abgeschlossen',
  'case.reopen': 'Vorgang wieder geöffnet',
  'entity.create': 'Eintrag angelegt',
  'entity.alias': 'Alternativen Namen hinzugefügt',
  'entity.merge': 'Einträge zusammengeführt',
  'entity.rename': 'Eintrag umbenannt',
  'persons.auto_merge': 'Personen automatisch zusammengeführt',
  'persons.self_merge': 'Eigenen Personeneintrag zusammengeführt',
  'person.create': 'Person angelegt',
  'topics.merge': 'Themen zusammengeführt',
  'subjects.update': 'Thema oder Projekt zugeordnet',
  'subjects.removeFurther': 'Weiteres Thema oder Projekt entfernt',
  'entries.bulkAssign': 'Mehrere Einträge zugeordnet',
  'relation.link': 'Verknüpfung angelegt',
  'relation.linkMany': 'Mehrere Verknüpfungen angelegt',
  'relation.unlink': 'Verknüpfung gelöst',
  'relation.confirm': 'Verknüpfung bestätigt',
  'relation.confirmMany': 'Mehrere Verknüpfungen bestätigt',
  'relation.reject': 'Verknüpfung abgelehnt',
  'relation.rejectMany': 'Mehrere Verknüpfungen abgelehnt',
  'relation.markDifferent': 'Als „verschieden“ markiert',
  'relation.decideMany': 'Mehrere Verknüpfungsvorschläge entschieden',
  'links.thresholds.reset': 'Schwellen für Verknüpfungsvorschläge zurückgesetzt',
  'note.create': 'Notiz angelegt',
  'note.update': 'Notiz bearbeitet',
  'note.delete': 'Notiz gelöscht',
  'note.merge_duplicate': 'Doppelte Notiz zusammengeführt',
  'event.create': 'Ereignis angelegt',
  'event.update': 'Ereignis bearbeitet',
  'event.delete': 'Ereignis gelöscht',
  'event.merge_duplicate': 'Doppeltes Ereignis zusammengeführt',
  'open_item.create': 'Offenen Punkt angelegt',
  'open_item.update': 'Offenen Punkt bearbeitet',
  'open_item.close': 'Offenen Punkt abgeschlossen',
  'open_item.add_source': 'Quelle zu einem offenen Punkt hinzugefügt',
  'open_item.solution': 'Lösungsvorschlag gespeichert',
  'open_item.solution_note': 'Lösung als Notiz gespeichert',
  'open_item.merge_duplicate': 'Doppelten offenen Punkt zusammengeführt',
  'reminder.create': 'Erinnerung angelegt',
  'reminder.snooze': 'Erinnerung verschoben',
  'scanner.addDirectory': 'Ordner zur Dokumentensuche hinzugefügt',
  'scanner.removeDirectory': 'Ordner aus der Dokumentensuche entfernt',
  'scanner.exclude.file': 'Datei von der Dokumentensuche ausgeschlossen',
  'scanner.exclude.directory': 'Ordner von der Dokumentensuche ausgeschlossen',
  'scanner.removeExclusion': 'Ausschluss von der Dokumentensuche aufgehoben',
  'scan.exclude': 'Von der Dokumentensuche ausgeschlossen',
  'scan.include': 'Wieder in die Dokumentensuche aufgenommen',
};

const ARCHIVE_PREFIX = 'archive.';
const REJECTED_PROPOSAL_PREFIX = 'action.reject:';
const ENTITY_ACTION = /^([a-z]+)\.(create|confirm)$/;

/** Actions whose name is built from a value: the archive mode, an entry type or a relation status. */
function composedLabel(action: string): string | undefined {
  if (action.startsWith(REJECTED_PROPOSAL_PREFIX)) return 'Vorschlag abgelehnt';
  const mode = action.slice(ARCHIVE_PREFIX.length) as keyof typeof ARCHIVE_MODE_SHORT;
  if (action.startsWith(ARCHIVE_PREFIX) && mode in ARCHIVE_MODE_SHORT) return `Dokument archiviert: ${ARCHIVE_MODE_SHORT[mode]}`;
  const status = action.replace(/^relation\./, '') as keyof typeof RELATION_STATUS_LABELS;
  if (action.startsWith('relation.') && status in RELATION_STATUS_LABELS) return `Verknüpfung: ${RELATION_STATUS_LABELS[status]}`;
  const entity = ENTITY_ACTION.exec(action);
  const type = entity?.[1] as keyof typeof ENTITY_TYPE_LABELS | undefined;
  if (entity && type && type in ENTITY_TYPE_LABELS) return `${ENTITY_TYPE_LABELS[type]} ${entity[2] === 'create' ? 'angelegt' : 'bestätigt'}`;
  return undefined;
}

/** The action in words; an action nobody labelled keeps its technical name (a unit test covers every action the core writes). */
export function auditActionLabel(action: string): string {
  if (action.startsWith('undo:')) return `Rückgängig: ${auditActionLabel(action.slice('undo:'.length))}`;
  return ACTION_LABELS[action] ?? composedLabel(action) ?? action;
}

const FIELD_LABELS: Record<string, string> = {
  title: 'Kurztitel',
  decisionText: 'Entscheidung',
  decidedAt: 'Wann',
  validFrom: 'Gültig ab',
  validUntil: 'Gültig bis',
  rationale: 'Begründung',
  consequences: 'Auswirkungen',
  sourceIds: 'Quellen',
  status: 'Status',
};

const MAX_VALUE_LENGTH = 140;
const DATE_FIELDS = new Set(['decidedAt', 'validFrom', 'validUntil']);

function shown(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '–';
  if (field === 'sourceIds' && Array.isArray(value)) return `${value.length} Quelle(n)`;
  if (DATE_FIELDS.has(field) && typeof value === 'string') return formatLongDate(value);
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)} …` : text;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** What an edit of a decision or a setting changed, as „Feld: vorher → nachher“; other entries show no values. */
export function auditChangeLines(entry: AuditEntry): string[] {
  if (!(entry.action === 'decision.update' || entry.action === 'settings.change') || !isRecord(entry.before) || !isRecord(entry.after)) return [];
  const before = entry.before;
  const after = entry.after;
  return Object.keys(after)
    .filter((field) => field !== 'missing' && JSON.stringify(before[field]) !== JSON.stringify(after[field]))
    .map((field) => `${FIELD_LABELS[field] ?? field}: ${shown(field, before[field])} → ${shown(field, after[field])}`);
}
