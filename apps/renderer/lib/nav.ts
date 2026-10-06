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

/** Colour family of an object type or section; `[data-tone]` in globals.css maps each to a colour token. */
export type Tone = 'primary' | 'document' | 'decision' | 'person' | 'project' | 'topic' | 'task' | 'danger' | 'neutral';

export const ENTITY_TYPE_TONES: Record<RefType, Tone> = {
  document: 'document',
  decision: 'decision',
  topic: 'topic',
  category: 'topic',
  tag: 'topic',
  project: 'project',
  case: 'project',
  person: 'person',
  task: 'task',
  question: 'task',
  reminder: 'task',
  contradiction: 'danger',
  event: 'neutral',
  note: 'neutral',
};
