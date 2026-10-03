import type { AuditEntry } from '@archivist/shared';
import { formatLongDate } from '@/lib/format';

const ACTION_LABELS: Record<string, string> = {
  'decision.create': 'Entscheidung angelegt',
  'decision.update': 'Entscheidung bearbeitet',
  'decision.supersede': 'Entscheidung als ersetzt markiert',
  'decision.revoke': 'Entscheidung widerrufen',
  'decision.delete': 'Entscheidung gelöscht',
  'settings.change': 'Einstellung geändert',
};

/** The action in words; actions without a label keep their technical name. */
export function auditActionLabel(action: string): string {
  if (action.startsWith('undo:')) return `Rückgängig: ${auditActionLabel(action.slice('undo:'.length))}`;
  return ACTION_LABELS[action] ?? action;
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
