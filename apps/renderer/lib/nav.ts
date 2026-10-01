import type { EntityType } from '@archivist/shared';

export function entityHref(type: EntityType, id: string): string {
  switch (type) {
    case 'document':
      return `/documents/?id=${encodeURIComponent(id)}`;
    case 'decision':
      return `/decisions/?id=${encodeURIComponent(id)}`;
    case 'task':
    case 'question':
      return '/open-items/';
    default:
      return `/knowledge/?id=${encodeURIComponent(id)}`;
  }
}

export const ENTITY_TYPE_LABELS: Record<EntityType, string> = {
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
};
