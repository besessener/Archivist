import type { ChatIntent, DecisionField } from '@archivist/shared';
import { parseDecisionDate, parseGermanDate } from '../../util/dates';
import { isExplicitDecision, isUndecidedWording } from '../../util/decision-language';
import { normalizeName, truncate } from '../../util/text';
import { deriveOpenItem, shortAnswer, TOPIC_KIND_RE, TOPIC_KIND_THEMA_RE, UNKNOWN_RE, words, type ConvState, type Pending } from '../chat-state';
import type { KnowledgeGraphService } from '../knowledge-graph';
import { knownSubjectIn, subjectFromText } from './subjects';

type RuleIntent = Omit<ChatIntent, 'confidence' | 'rationale'>;
type DecisionAnswer = NonNullable<ChatIntent['decision']>;

const QUESTION_END = /\?\s*$/;

/** Emergency fallback without LLM (only if the endpoint is unreachable or not configured). */
export class RuleBasedIntents {
  constructor(private readonly graph: KnowledgeGraphService) {}

  classify(text: string, state: ConvState): ChatIntent {
    const trimmed = text.trim();
    const base = { confidence: 0.45, rationale: 'Regelbasierte Erkennung (LLM nicht verfügbar).' };
    const generic: ChatIntent = { ...base, ...this.intentOf(trimmed) };
    // the message only counts as an answer to the follow-up question if it has no recognizable request of its own
    const answer = state.pending && generic.intent === 'note_capture' ? answerToPending(trimmed, state.pending) : null;
    return answer ? { ...base, ...answer } : generic;
  }

  private intentOf(text: string): RuleIntent {
    const short = shortAnswer(text);
    if (short) return { intent: short === 'yes' ? 'proposal_confirm' : 'proposal_reject' };
    return this.captureIntent(text) ?? this.archiveIntent(text) ?? lookupIntent(text);
  }

  private captureIntent(text: string): RuleIntent | null {
    if (/\b(entschieden|beschlossen|entscheidung:)/i.test(text) && !QUESTION_END.test(text) && !isUndecidedWording(text)) return this.decisionIntent(text);
    if (/\b(erinner\w*)\b/i.test(text))
      return {
        intent: /verschieb|erneut|wieder/i.test(text) ? 'reminder_snooze' : 'reminder_create',
        reminder: { relativeText: text, remindAt: parseGermanDate(text) },
      };
    if (/\b(schlie(ß|ss)e?\w*|erledigt|abgeschlossen)\b/i.test(text) && /(punkt|aufgabe|todo)/i.test(text))
      return { intent: 'open_item_close', openItem: { targetHint: text } };
    if (/(offene[rn]?\s+punkt|todo|aufgabe|noch\s+(zu\s+)?klären|muss\s+noch)/i.test(text) && !QUESTION_END.test(text) && !/^welche/i.test(text))
      return { intent: 'open_item_new', openItem: { ...deriveOpenItem(text), dueAt: parseGermanDate(text) } };
    return null;
  }

  private decisionIntent(text: string): RuleIntent {
    const known = [...this.graph.listEntities({ type: 'topic', limit: 200 }), ...this.graph.listEntities({ type: 'project', limit: 200 })].map((e) => e.name);
    const lower = ` ${normalizeName(text)} `;
    const topic = known.find((k) => lower.includes(` ${normalizeName(k)} `)) ?? /\b([a-z0-9]+(?:[-_][a-z0-9]+)+)\b/i.exec(text)?.[1] ?? null;
    return {
      intent: 'decision_new',
      decisionCertainty: isExplicitDecision(text) ? 'clear' : 'unsure',
      decision: {
        decisionText: text.replace(/^wir\s+haben\s+(?:uns\s+)?(?:gemeinsam\s+)?(?:entschieden|beschlossen),?\s*(?:dass\s+)?/i, '').trim() || text,
        title: truncate(text, 80),
        decidedAt: parseDecisionDate(text),
        topic,
        participants: [],
        alternatives: [],
        unknownFields: [],
        confidence: 0.4,
        topicIsProject: null,
      },
    };
  }

  /** Scan, timeline, status and filing requests; null when none fits. */
  private archiveIntent(text: string): RuleIntent | null {
    if (/\b(scan|nach\s+neuen\s+dokumenten)\b/i.test(text)) return { intent: 'scan_start' };
    // eslint-disable-next-line sonarjs/super-linear-regex -- single chat message, limited length
    if (/\b(timeline|zeitverlauf|chronolog|was\s+ist\s+.*passiert)\b/i.test(text)) return { intent: 'timeline_query', query: text };
    if (/\b(archivstatus|zustand\s+des\s+archivs|wie\s+viele\s+dokumente)\b/i.test(text)) return { intent: 'archive_status' };
    if (
      /(verzeichnis|ordner|ablage)/i.test(text) &&
      /(selbe|gleiche|zusammen|alle\s+in|ein(?:en)?\s+(?:verzeichnis|ordner)|verschieb|umlager|zusammenleg|zusammenführ)/i.test(text)
    )
      return { intent: 'archive_reorganize', topic: this.subjectIn(text) };
    if (/(konsisten|verzeichnis|ordner|ablage|verstreut|durcheinander|struktur)/i.test(text))
      return { intent: 'archive_structure', topic: this.subjectIn(text) };
    return null;
  }

  private subjectIn(text: string): string | null {
    const names = [...this.graph.listEntities({ type: 'topic', limit: 500 }), ...this.graph.listEntities({ type: 'project', limit: 500 })].map((e) => e.name);
    return knownSubjectIn(text, names) ?? subjectFromText(text);
  }
}

function lookupIntent(text: string): RuleIntent {
  if (/\bwiderspr/i.test(text)) return { intent: 'contradiction_check', query: text };
  if (/(dokumente?|dateien?)/i.test(text) && /(such|zeige|finde|gehören|liste)/i.test(text)) return { intent: 'document_search', query: text };
  if (QUESTION_END.test(text) || /^(wann|warum|wer|was|welche|wie|haben|gab|gibt|hat)\b/i.test(text)) return { intent: 'knowledge_question', query: text };
  return { intent: 'note_capture', note: text };
}

/** Without LLM a message only answers the open follow-up question if it is short and fits it (date, name, „unbekannt“). */
function answerToPending(text: string, pending: Pending): RuleIntent | null {
  switch (pending.kind) {
    case 'decision':
      return decisionAnswer(text, pending);
    case 'reminder':
      return datedAnswer(text, (remindAt) => ({ intent: pending.snooze ? 'reminder_snooze' : 'reminder_create', reminder: { relativeText: text, remindAt } }));
    case 'event':
      return datedAnswer(text, (occurredAt) => ({ intent: 'event_record', event: { title: pending.title, description: pending.description, occurredAt } }));
    case 'open_item':
      return openItemAnswer(text);
    default:
      return null;
  }
}

function datedAnswer(text: string, toIntent: (date: string) => RuleIntent): RuleIntent | null {
  const date = words(text) <= 8 ? parseGermanDate(text) : null;
  return date ? toIntent(date) : null;
}

const NO_ANSWER = { fields: {}, fits: false };

function decisionAnswer(text: string, pending: Extract<Pending, { kind: 'decision' }>): RuleIntent | null {
  const unknown = UNKNOWN_RE.test(text) && words(text) <= 8;
  const topicKind = pending.clarifyTopic && words(text) <= 8 ? topicKindAnswer(text) : NO_ANSWER;
  const field = unknown ? NO_ANSWER : fieldAnswer(text, pending.asked[0]);
  if (!unknown && !topicKind.fits && !field.fits) return null;
  return {
    intent: 'decision_amend',
    decision: { participants: [], alternatives: [], unknownFields: unknown ? pending.asked : [], confidence: 0.4, ...topicKind.fields, ...field.fields },
  };
}

/** Only unambiguous answers to „Thema oder Projekt?“: „Projekt“ or „Thema“, not both. */
function topicKindAnswer(text: string): { fields: Partial<DecisionAnswer>; fits: boolean } {
  const isProject = TOPIC_KIND_RE.test(text);
  return isProject === TOPIC_KIND_THEMA_RE.test(text) ? NO_ANSWER : { fields: { topicIsProject: isProject }, fits: true };
}

/** The first asked field of a decision, read from a short answer. */
function fieldAnswer(text: string, field: DecisionField | undefined): { fields: Partial<DecisionAnswer>; fits: boolean } {
  const looksLikeAnswer = words(text) <= 8 && !shortAnswer(text) && !QUESTION_END.test(text);
  if (field === 'decidedAt' && words(text) <= 8) {
    const decidedAt = parseDecisionDate(text);
    return { fields: { decidedAt }, fits: Boolean(decidedAt) };
  }
  if (field === 'participants' && looksLikeAnswer) {
    const participants = text
      .split(/,|\bund\b|&|;/i)
      .map((x) => x.replace(/^(mit|von|zusammen mit)\s+/i, '').trim())
      .filter(Boolean);
    return { fields: { participants }, fits: participants.length > 0 };
  }
  if (field === 'topic' && looksLikeAnswer) {
    const topic = text.replace(/^(es\s+geht\s+um|thema:?)\s*/i, '').trim();
    return { fields: { topic }, fits: Boolean(topic) };
  }
  if (field === 'decisionText' && words(text) <= 60 && !shortAnswer(text) && !QUESTION_END.test(text)) return { fields: { decisionText: text }, fits: true };
  return NO_ANSWER;
}

function openItemAnswer(text: string): RuleIntent | null {
  if (words(text) > 10 || shortAnswer(text) || QUESTION_END.test(text)) return null;
  const parts = text
    .split(/[,;]|\bund\b/)
    .map((x) => x.trim())
    .filter(Boolean);
  const dueAt = parts.map((x) => parseGermanDate(x)).find(Boolean) ?? null;
  const name = parts
    .filter((x) => !parseGermanDate(x) && !UNKNOWN_RE.test(x))
    .map((x) => x.replace(/^(verantwortlich(er)?:?|@)\s*/i, '').trim())
    .find((x) => x && words(x) <= 4);
  const unknown = UNKNOWN_RE.test(text) && words(text) <= 8;
  if (!dueAt && !name && !unknown) return null;
  return { intent: 'open_item_update', openItem: { dueAt, responsible: name ?? null } };
}
