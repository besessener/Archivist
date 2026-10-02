import type { RefType } from '@archivist/shared';

export function entityHref(type: RefType, id: string): string {
  switch (type) {
    case 'document':
      return `/documents/?id=${encodeURIComponent(id)}`;
    case 'decision':
      return `/decisions/?id=${encodeURIComponent(id)}`;
    // Reminders are attached to open items; due ones additionally appear in the notification bell
    case 'task':
    case 'question':
    case 'reminder':
      return '/open-items/';
    case 'contradiction':
      return '/insights/';
    default:
      return `/knowledge/?id=${encodeURIComponent(id)}`;
  }
}

export const ENTITY_TYPE_LABELS: Record<RefType, string> = {
  document: 'Dokument',
  decision: 'Entscheidung',
  topic: 'Thema',
  project: 'Projekt',
  person: 'Person',
  event: 'Ereignis',
  question: 'Frage',
  task: 'Aufgabe',
  note: 'Notiz',
  category: 'Kategorie',
  tag: 'Schlagwort',
  case: 'Vorgang',
  reminder: 'Erinnerung',
  contradiction: 'Widerspruch',
};
