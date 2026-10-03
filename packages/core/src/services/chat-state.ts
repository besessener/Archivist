import { type ChatContext, type Decision, type DecisionField, type EntityRef, type SourceReference, type StoredAgentAction } from '@archivist/shared';
import { eq } from 'drizzle-orm';
import type { ChatIntent } from '@archivist/shared';
import type { AppContext } from '../context';
import { conversations } from '../db/schema';
import { normalizeName, truncate } from '../util/text';
import type { AgentChatState } from '../agent/registry';

export type OpenItemField = 'responsible' | 'due';

export interface OpenItemAsk {
  openItemId: string;
  asked: OpenItemField[];
}

export type OpenItemPending = Extract<Pending, { kind: 'open_item' }>;

export function openItemAsks(p: OpenItemPending): OpenItemAsk[] {
  return [{ openItemId: p.openItemId, asked: p.asked }, ...(p.more ?? [])];
}

/** Follow-up question about one or more open items; null if nothing is asked. */
export function openItemPending(entries: OpenItemAsk[], { optional }: { optional?: boolean } = {}): OpenItemPending | null {
  const [first, ...more] = entries;
  if (!first) return null;
  return { kind: 'open_item', ...first, optional, ...(more.length ? { more } : {}) };
}

export type Pending =
  | {
      kind: 'decision';
      decisionId: string;
      asked: DecisionField[];
      clarifyTopic?: string | null;
      supersedes?: string | null;
      supersedesId?: string | null;
      /** only „Thema oder Projekt?“ is still open – does not hold up further requests */
      optional?: boolean;
    }
  | {
      kind: 'open_item';
      openItemId: string;
      asked: OpenItemField[];
      optional?: boolean;
      /** further items asked about in the same reply („3 offene Punkte angelegt – bis wann?“) */
      more?: OpenItemAsk[];
    }
  | { kind: 'open_item_duplicate'; existingId: string; text: string; intent: ChatIntent }
  | { kind: 'reminder'; title: string; targetId: string | null; snooze: boolean; source: string }
  | { kind: 'confirm_save'; text: string; intent: ChatIntent }
  | { kind: 'proposal_choice'; confirm: boolean; actionIds: string[] }
  | { kind: 'supersede_choice'; newDecisionId: string; candidateIds: string[] }
  | { kind: 'open_item_choice'; text: string; intent: ChatIntent; candidateIds: string[] }
  | { kind: 'subject_choice'; text: string; intent: ChatIntent; names: string[] }
  | {
      kind: 'event';
      title: string;
      description: string | null;
      topic: string | null;
      project: string | null;
      /** absent in states stored before #274 */
      participants?: string[];
      source: string;
    };

/** Further recognized intents that are still processed after a follow-up question has been answered. */
export interface QueuedIntent {
  text: string;
  intent: ChatIntent;
}

export interface ConvState {
  pending?: Pending | null;
  queue?: QueuedIntent[];
  last?: { openItemId?: string; decisionId?: string; documentIds?: string[]; topic?: string | null };
  /** Agent mode (#294): short ids, mode override and the request a question was asked about. */
  agent?: AgentChatState;
  /** The note „rule-based because there is no LLM“ was shown in this conversation (#248). */
  rulesHintShown?: boolean;
}

export interface Reply {
  intent: string;
  content: string;
  sources?: SourceReference[];
  context?: Partial<ChatContext>;
  actions?: StoredAgentAction[];
  confidence?: number | null;
  uncertainties?: string[];
  errorMessage?: string | null;
  quickReplies?: string[];
  state?: ConvState;
  runId?: string | null;
}

export const UNKNOWN_RE = /(wei(ß|ss)\s+(ich|man)\s+(nicht|nich)|unbekannt|keine\s+ahnung|nicht\s+bekannt|k\.?\s?a\.?$|egal|spielt\s+keine\s+rolle)/i;

export const TOPIC_KIND_RE = /\b(projekt|projektname)\b/i;

export const TOPIC_KIND_THEMA_RE = /\b(thema|themas)\b/i;

export const TOPIC_KIND_QUICK_REPLIES = ['Thema', 'Projekt'];

export const OPEN_ITEM_PREFIX_RE = /^\s*(?:offene[rn]?\s+punkte?|offen|todo|to-do|aufgabe|neue\s+aufgabe|merke?\s+dir)\s*[:–-]\s*/i;

export const MUST_RE = /^\s*(?:ich|wir|du|man)\s+(?:muss|müssen|musst|sollte|sollten|sollen|will|wollen|möchte|möchten)\s+(?:noch\s+|unbedingt\s+|bald\s+)*/i;

export const OPEN_TRIGGER_RE = /(offene[rn]?\s+punkt|offen\s*:|todo|to-do|aufgabe|noch\s+(?:zu\s+)?klären|muss\s+noch|müssen\s+noch|sollten?\s+noch)/i;

/** Open item from its part of the text: prefixes („Offener Punkt:“, „Ich muss noch …“) dropped, first clause as title, the rest as description. */
export function deriveOpenItem(text: string): { title: string; description: string | null } {
  const sentences = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const sentence = (sentences.find((x) => OPEN_TRIGGER_RE.test(x)) ?? sentences[0] ?? text).trim();
  let core = sentence.replace(OPEN_ITEM_PREFIX_RE, '').replace(MUST_RE, '').trim();
  while (core.endsWith('.') || core.endsWith('!')) core = core.slice(0, -1).trimEnd();
  const first = (core.split(/[,;]| [–-] /)[0] ?? core).trim();
  const title = truncate(first.charAt(0).toUpperCase() + first.slice(1), 100);
  const rest = core.length > first.length + 3 ? core : null;
  return { title: title || truncate(text.trim(), 100), description: rest };
}

/** Appends an addition to a description (instead of overwriting it); what is already contained is not appended twice. */
export function appendDescription(current: string | null, addition: string | null | undefined): string | null {
  const add = addition?.trim();
  if (!add) return current;
  if (!current?.trim()) return add;
  return normalizeName(current).includes(normalizeName(add)) ? current : `${current.trim()}\n${add}`;
}

/** Which details does an answer name as unknown? („Anna, Termin unbekannt“ → only the due date) */
export function unknownFieldsIn(text: string): { due: boolean; responsible: boolean; generic: boolean } {
  const parts = text
    .split(/[,;]|\bund\b/)
    .map((p) => p.trim())
    .filter((p) => UNKNOWN_RE.test(p));
  const due = parts.some((p) => /(termin|fällig|faellig|datum|frist|wann|zeitpunkt|deadline)/i.test(p));
  const responsible = parts.some((p) => /(verantwort|zuständig|wer\b|person)/i.test(p));
  return { due, responsible, generic: parts.length > 0 && !due && !responsible };
}

export const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

export const YES_START = new Set([
  'ja',
  'jap',
  'jo',
  'jawohl',
  'ok',
  'okay',
  'passt',
  'gerne',
  'gern',
  'bitte',
  'bestatigen',
  'bestatige',
  'einverstanden',
  'genau',
  'klar',
  'mach',
  'machen',
  'ausfuhren',
  'los',
]);

export const YES_FILL = new Set([
  ...YES_START,
  'das',
  'es',
  'so',
  'gut',
  'danke',
  'sehr',
  'auch',
  'aus',
  'fuhr',
  'ruhig',
  'doch',
  'na',
  'dann',
  'sicher',
  'gemacht',
]);

export const NO_START = new Set(['nein', 'nee', 'ne', 'no', 'ablehnen', 'lehne', 'verwerfen', 'lass', 'lieber', 'nicht']);

export const NO_FILL = new Set([
  ...NO_START,
  'das',
  'es',
  'ab',
  'sein',
  'bleiben',
  'machen',
  'mach',
  'nicht',
  'lieber',
  'danke',
  'bitte',
  'doch',
  'ausfuhren',
  'so',
  'nichts',
  'tun',
]);

/** Short approval or refusal („ja, mach das“, „nein danke“) – without LLM the only answer to a proposal; „Bitte zeig mir …“ is none. */
export function shortAnswer(text: string): 'yes' | 'no' | null {
  const words = normalizeName(text).split(' ').filter(Boolean);
  if (!words.length || words.length > 6) return null;
  const fits = (start: Set<string>, fill: Set<string>) => start.has(words[0]!) && words.every((w) => fill.has(w));
  if (fits(YES_START, YES_FILL)) return 'yes';
  if (fits(NO_START, NO_FILL)) return 'no';
  return null;
}

export function decisionRef(d: Decision): EntityRef {
  return { type: 'decision', id: d.id, label: d.title, detail: d.decidedAt?.slice(0, 10) ?? null };
}

export function decisionSource(d: Decision, score = 1): SourceReference {
  return {
    id: d.id,
    type: 'decision',
    title: d.title,
    snippet: truncate(d.decisionText, 240),
    path: null,
    date: d.decidedAt,
    dateKind: d.decidedAt ? 'decided' : null,
    score,
  };
}

const CONTEXT_KEYS = ['topics', 'projects', 'persons', 'decisions', 'openItems', 'documents', 'contradictions'] as const;

/** The context entries of several replies, each entry once per list. */
function mergedContext(replies: Reply[]): Partial<ChatContext> {
  const context: Partial<ChatContext> = {};
  for (const key of CONTEXT_KEYS) {
    const seen = new Map<string, EntityRef>();
    for (const r of replies) for (const e of r.context?.[key] ?? []) seen.set(`${e.type}:${e.id}`, e);
    if (seen.size) context[key] = [...seen.values()];
  }
  return context;
}

export function mergeReplies(replies: Reply[], finalState: ConvState): Reply {
  const last = replies[replies.length - 1]!;
  if (replies.length === 1) return { ...last, state: finalState };
  const sources = new Map<string, SourceReference>();
  for (const r of replies) for (const src of r.sources ?? []) sources.set(`${src.type}:${src.id}`, src);
  const actions = new Map<string, StoredAgentAction>();
  for (const r of replies) for (const a of r.actions ?? []) actions.set(a.id, a);
  const confidences = replies.map((r) => r.confidence).filter((c): c is number => typeof c === 'number');
  return {
    intent: replies.find((r) => r.intent !== 'clarification')?.intent ?? last.intent,
    content: replies.map((r) => r.content).join('\n\n'),
    sources: [...sources.values()],
    context: mergedContext(replies),
    actions: [...actions.values()],
    confidence: confidences.length ? Math.min(...confidences) : null,
    uncertainties: [...new Set(replies.flatMap((r) => r.uncertainties ?? []))],
    errorMessage: replies.map((r) => r.errorMessage).find(Boolean) ?? null,
    quickReplies: [...replies].reverse().find((r) => r.quickReplies?.length)?.quickReplies ?? [],
    state: finalState,
  };
}

/** State of a conversation (follow-up question, queue, last items, agent state) as the chat stores it. */
export function conversationState(db: AppContext['database']['db'], id: string): ConvState {
  return (db.select().from(conversations).where(eq(conversations.id, id)).get()?.pending as ConvState | null) ?? {};
}
