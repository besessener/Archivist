import { z } from 'zod';
import { ArchiveLocationProposal, DecisionField } from './domain';
import { Confidence, RelationType } from './common';

export { AgentActionProposal, ArchiveLocationProposal } from './domain';
export { SourceReference } from './common';

/** LLMs liefern gern null statt fehlender Felder. */
const opt = <T extends z.ZodType>(t: T) => t.nullish();

export const INTENTS = [
  'decision_new',
  'decision_amend',
  'decision_supersede',
  'note_capture',
  'knowledge_question',
  'document_search',
  'timeline_query',
  'event_record',
  'open_item_new',
  'open_item_update',
  'open_item_close',
  'reminder_create',
  'reminder_snooze',
  'proposal_confirm',
  'proposal_reject',
  'archive_execute',
  'archive_status',
  'scan_start',
  'exclude_path',
  'contradiction_check',
  'relation_decide',
  'smalltalk',
  'unknown',
] as const;
export const IntentKind = z.enum(INTENTS);
export type IntentKind = z.infer<typeof IntentKind>;

export const DecisionExtraction = z.object({
  title: opt(z.string()),
  decisionText: opt(z.string()),
  decidedAt: opt(z.string()).describe('ISO-Datum YYYY-MM-DD, nur wenn explizit genannt oder eindeutig ableitbar'),
  topic: opt(z.string()),
  project: opt(z.string()),
  participants: z.array(z.string()).default([]),
  rationale: opt(z.string()),
  consequences: opt(z.string()),
  alternatives: z.array(z.string()).default([]),
  validFrom: opt(z.string()),
  validUntil: opt(z.string()),
  topicIsProject: opt(z.boolean()).describe('true, wenn das genannte Thema in Wahrheit ein Projektname ist'),
  unknownFields: z.array(DecisionField).default([]).describe('Felder, die der Benutzer ausdrücklich als unbekannt bezeichnet'),
  confidence: Confidence.default(0.7),
});
export type DecisionExtraction = z.infer<typeof DecisionExtraction>;

export const OpenQuestionExtraction = z.object({
  items: z
    .array(
      z.object({
        title: z.string(),
        description: opt(z.string()),
        topic: opt(z.string()),
        project: opt(z.string()),
        responsible: opt(z.string()),
        dueAt: opt(z.string()),
        priority: z.enum(['low', 'normal', 'high']).default('normal'),
        evidence: opt(z.string()).describe('wörtliche Textstelle'),
        confidence: Confidence.default(0.7),
      }),
    )
    .default([]),
});
export type OpenQuestionExtraction = z.infer<typeof OpenQuestionExtraction>;

export const ChatIntent = z.object({
  intent: IntentKind,
  confidence: Confidence,
  rationale: z.string().default(''),
  query: opt(z.string()).describe('Such- bzw. Fragetext'),
  topic: opt(z.string()),
  project: opt(z.string()),
  timeRange: opt(z.object({ from: opt(z.string()), to: opt(z.string()) })),
  decision: opt(DecisionExtraction),
  openItem: opt(
    z.object({
      title: opt(z.string()),
      description: opt(z.string()),
      responsible: opt(z.string()),
      dueAt: opt(z.string()),
      priority: opt(z.enum(['low', 'normal', 'high'])),
      targetHint: opt(z.string()).describe('Hinweis, welcher bestehende offene Punkt gemeint ist'),
      newStatus: opt(z.enum(['open', 'waiting', 'blocked', 'resolved', 'dismissed'])),
    }),
  ),
  event: opt(
    z.object({
      title: opt(z.string()),
      description: opt(z.string()),
      occurredAt: opt(z.string()).describe('ISO-Datum YYYY-MM-DD, an dem das Ereignis stattfand'),
    }),
  ),
  reminder: opt(z.object({ remindAt: opt(z.string()), relativeText: opt(z.string()), targetHint: opt(z.string()), title: opt(z.string()) })),
  path: opt(z.string()),
  note: opt(z.string()),
  decisionCertainty: opt(z.enum(['clear', 'unsure'])).describe(
    'Nur bei decision_new: clear = ausdrücklich getroffene Entscheidung; unsure = könnte auch Plan, Ereignis, Status oder Notiz sein',
  ),
  segment: opt(z.string()).describe('Der Teil der Nachricht, auf den sich diese Absicht bezieht'),
});
export type ChatIntent = z.infer<typeof ChatIntent>;

/** Ergebnis der Intent-Analyse: eine Nachricht kann mehrere Absichten enthalten. */
export const ChatAnalysis = z.object({
  intents: z.array(ChatIntent).min(1).max(5),
  clarification: opt(z.string()).describe('Rückfrage an den Benutzer, wenn die Absicht unklar ist und nichts geraten werden soll'),
});
export type ChatAnalysis = z.infer<typeof ChatAnalysis>;

export const DocumentClassification = z.object({
  docType: z.string().describe('z. B. Vertrag, Protokoll, Rechnung, Notiz, Präsentation'),
  title: z.string(),
  summary: z.string(),
  mainTopic: opt(z.string()),
  project: opt(z.string()),
  persons: z.array(z.string()).default([]),
  dates: z.array(z.object({ date: z.string(), label: opt(z.string()) })).default([]),
  tags: z.array(z.string()).default([]),
  location: ArchiveLocationProposal,
  decisions: z
    .array(z.object({ title: z.string(), decisionText: z.string(), decidedAt: opt(z.string()), participants: z.array(z.string()).default([]) }))
    .default([]),
  openItems: z.array(z.object({ title: z.string(), description: opt(z.string()), dueAt: opt(z.string()), responsible: opt(z.string()) })).default([]),
  confidence: Confidence,
  rationale: z.string().default(''),
});
export type DocumentClassification = z.infer<typeof DocumentClassification>;

export const EntityExtraction = z.object({
  topics: z.array(z.string()).default([]),
  projects: z.array(z.string()).default([]),
  persons: z.array(z.string()).default([]),
  events: z.array(z.object({ name: z.string(), date: opt(z.string()) })).default([]),
});
export type EntityExtraction = z.infer<typeof EntityExtraction>;

export const RelationshipProposal = z.object({
  relations: z
    .array(
      z.object({
        sourceId: z.string(),
        targetId: z.string(),
        relationType: RelationType,
        confidence: Confidence,
        rationale: z.string().default(''),
      }),
    )
    .default([]),
});
export type RelationshipProposal = z.infer<typeof RelationshipProposal>;

export const ContradictionProposal = z.object({
  isContradiction: z.boolean(),
  title: z.string().default(''),
  description: z.string().default(''),
  excerpts: z.array(z.object({ entityId: z.string(), text: z.string() })).default([]),
  confidence: Confidence,
});
export type ContradictionProposal = z.infer<typeof ContradictionProposal>;

export const KnowledgeAnswer = z.object({
  answer: z.string(),
  facts: z.array(z.object({ statement: z.string(), sourceIds: z.array(z.string()) })).default([]),
  interpretation: opt(z.string()),
  uncertainties: z.array(z.string()).default([]),
  contradictions: z.array(z.object({ description: z.string(), sourceIds: z.array(z.string()) })).default([]),
  missingInformation: z.array(z.string()).default([]),
  usedSourceIds: z.array(z.string()).default([]),
  confidence: Confidence,
});
export type KnowledgeAnswer = z.infer<typeof KnowledgeAnswer>;
