import type { RefType } from '@archivist/shared';

export function entityHref(type: RefType, id: string): string {
  switch (type) {
    case 'document':
      return `/documents/?id=${encodeURIComponent(id)}`;
    case 'decision':
      return `/decisions/?id=${encodeURIComponent(id)}`;
    // Erinnerungen hängen an offenen Punkten; fällige erscheinen zusätzlich in der Notification Bell
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
  reminder: 'Erinnerung',
  contradiction: 'Widerspruch',
};
