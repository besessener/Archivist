import type { ChatIntent } from '@archivist/shared';
import { ordinalIndex } from '../../util/ordinals';
import { parseGermanDate } from '../../util/dates';
import { normalizeName, truncate } from '../../util/text';
import { shortAnswer, type Pending } from '../chat-state';

const INTENT_LABELS: Partial<Record<ChatIntent['intent'], string>> = {
  decision_new: 'Entscheidung',
  decision_amend: 'Entscheidung ergänzen',
  decision_supersede: 'Entscheidung ersetzen',
  note_capture: 'Notiz',
  knowledge_question: 'Frage',
  document_search: 'Dokumentsuche',
  timeline_query: 'Zeitverlauf',
  event_record: 'Ereignis',
  open_item_new: 'offener Punkt',
  open_item_update: 'offenen Punkt ändern',
  open_item_close: 'offenen Punkt schließen',
  reminder_create: 'Erinnerung',
  reminder_snooze: 'Erinnerung verschieben',
  archive_execute: 'Archivieren',
  archive_status: 'Archivstatus',
  archive_structure: 'Ablage prüfen',
  archive_reorganize: 'Dokumente umlagern',
  scan_start: 'Scan',
  exclude_path: 'Ausschluss',
  contradiction_check: 'Widerspruchsprüfung',
  contradiction_resolve: 'Widerspruch auflösen',
  relation_decide: 'Beziehungen',
};

/** Identity of a request within one message: kind, text segment and the object it targets. */
export function intentKey(intent: ChatIntent): string {
  return JSON.stringify([
    intent.intent,
    intent.segment ?? '',
    intent.openItem?.targetId ?? null,
    intent.openItem?.targetHint ?? null,
    intent.reminder?.targetId ?? null,
  ]);
}

export function describeIntent(intent: ChatIntent): string {
  const label = INTENT_LABELS[intent.intent] ?? intent.intent;
  return intent.segment?.trim() ? `${label}: „${truncate(intent.segment.trim(), 80)}“` : label;
}

export type SaveChoice = 'decision' | 'event' | 'note' | 'nothing';

/** Intents the LLM might return for a mere answer to „Entscheidung, Ereignis, Notiz oder nichts?“. */
export const SAVE_ANSWER_INTENTS = new Set<ChatIntent['intent']>([
  'unknown',
  'smalltalk',
  'proposal_confirm',
  'proposal_reject',
  'note_capture',
  'decision_new',
  'decision_amend',
  'event_record',
]);

export const SAVE_QUICK_REPLIES = ['Entscheidung', 'Ereignis', 'Notiz', 'Nichts speichern'];

const SAVE_OPTIONS: Array<[Exclude<SaveChoice, 'nothing'>, string]> = [
  ['decision', 'entscheidung'],
  ['event', '(?:ereignis|termin|timeline)'],
  ['note', '(?:notiz|merken|festhalten|merk)'],
];

/** Answer to „Entscheidung, Ereignis, Notiz oder nichts?“, negations included („keine Entscheidung, sondern …“); ambiguous → null. */
export function parseSaveChoice(text: string): SaveChoice | null {
  const normalized = normalizeName(text);
  if (!normalized || normalized.split(' ').length > 10) return null;
  const negated = (word: string) => new RegExp(`\\b(?:kein(?:e|en)?|nicht(?: als| eine?)?)\\s+${word}`).test(normalized);
  const after = /\bsondern\b(.*)$/.exec(normalized)?.[1] ?? null;
  const pick = (scope: string) =>
    SAVE_OPTIONS.filter(([, word]) => new RegExp(`\\b${word}`).test(scope) && (scope !== normalized || !negated(word))).map(([choice]) => choice);
  const chosen = after !== null ? pick(after) : pick(normalized);
  if (chosen.length === 1) return chosen[0]!;
  if (chosen.length > 1) return null;
  if (/\b(nichts|gar nicht|nicht speichern|verwerf\w*|vergiss)\b/.test(normalized)) return 'nothing';
  return shortAnswer(text) === 'no' ? 'nothing' : null;
}

/** The request a save choice turns the uncertain decision into (not for „nothing“). */
export function saveChoiceIntent(choice: Exclude<SaveChoice, 'nothing'>, pending: Extract<Pending, { kind: 'confirm_save' }>): ChatIntent {
  const segment = pending.intent.segment ?? pending.text;
  if (choice === 'decision') return { ...pending.intent, intent: 'decision_new', decisionCertainty: 'clear' };
  if (choice === 'note') return { ...pending.intent, intent: 'note_capture', note: segment };
  return {
    ...pending.intent,
    intent: 'event_record',
    event: {
      title: pending.intent.decision?.title ?? truncate(segment, 100),
      description: segment,
      occurredAt: pending.intent.decision?.decidedAt ?? parseGermanDate(segment),
    },
  };
}

/** Sets the chosen open item as the target of a request (open item or reminder). */
export function withOpenItemTarget(intent: ChatIntent, id: string): ChatIntent {
  if (intent.intent === 'reminder_create' || intent.intent === 'reminder_snooze') return { ...intent, reminder: { ...(intent.reminder ?? {}), targetId: id } };
  return { ...intent, openItem: { ...(intent.openItem ?? {}), targetId: id } };
}

/** Is it unclear whether a decision should be saved? */
export function needsDecisionConfirmation(intent: ChatIntent): boolean {
  if (intent.intent !== 'decision_new') return false;
  return intent.decisionCertainty === 'unsure' || (intent.confidence < 0.55 && intent.decisionCertainty !== 'clear');
}

/** Follow-up questions that offer a choice; the answer is evaluated before the message is classified. */
export type ChoicePending = Extract<Pending, { kind: 'proposal_choice' | 'open_item_choice' | 'subject_choice' | 'open_item_duplicate' | 'supersede_choice' }>;

const CHOICE_KINDS = new Set<Pending['kind']>(['proposal_choice', 'open_item_choice', 'subject_choice', 'open_item_duplicate', 'supersede_choice']);

export function isChoice(pending: Pending | null | undefined): pending is ChoicePending {
  return Boolean(pending && CHOICE_KINDS.has(pending.kind));
}

/** Answer to „Meinst du „Bildungsurlaub 2025“ oder „Bildungsurlaub 2026“?“: number, exact name or a unique part of one. */
export function chosenSubject(text: string, pending: Extract<Pending, { kind: 'subject_choice' }>): string | null {
  const answer = normalizeName(text);
  const number = /^(\d+)$/.exec(answer)?.[1];
  const containing = pending.names.filter((name) => normalizeName(name).includes(answer));
  const ordinal = ordinalIndex(answer);
  const chosen = number
    ? pending.names[Number(number) - 1]
    : ordinal >= 0
      ? pending.names[ordinal]
      : (pending.names.find((name) => normalizeName(name) === answer) ?? (answer.length >= 2 ? containing.at(0) : undefined));
  return chosen && (number || containing.length <= 1) ? chosen : null;
}
