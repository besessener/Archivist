import { z } from 'zod';
import { Confidence, RelationType } from './common';
import { DecisionField, DecisionKind } from './decisions';
import { ArchiveLocationProposal } from './documents';

/** LLMs tend to return null instead of omitting fields. */
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
  'archive_structure',
  'archive_reorganize',
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
  supersedesId: opt(z.string()).describe('Bei decision_supersede: ID der ersetzten Entscheidung aus dem Kontext (z. B. „E3“)'),
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
  alternativeQueries: opt(z.array(z.string()).transform((queries) => queries.slice(0, 4))).describe(
    'Nur bei Fragen/Suchen: 2–4 weitere Suchformulierungen (Synonyme, Umschreibungen, dieselben Kernbegriffe auf Englisch bzw. Deutsch)',
  ),
  topic: opt(z.string()),
  project: opt(z.string()),
  timeRange: opt(z.object({ from: opt(z.string()), to: opt(z.string()) })),
  decision: opt(DecisionExtraction),
  openItem: opt(
    z.object({
      title: opt(z.string()).describe('Kurzer Titel aus Subjekt und Tätigkeit, z. B. „Angebot Müller prüfen“ – nie die ganze Nachricht'),
      description: opt(z.string()).describe('Alle Details aus dem zugehörigen Textteil (Hintergrund, Bedingungen, z. B. „er wollte Rabatt“)'),
      responsible: opt(z.string()).describe('Verantwortliche Person; „ich/mir/mich“ meint den Benutzer'),
      dueAt: opt(z.string()).describe('Fälligkeit als ISO-Datum YYYY-MM-DD'),
      priority: opt(z.enum(['low', 'normal', 'high'])),
      targetId: opt(z.string()).describe('ID eines bestehenden offenen Punkts aus dem Kontext (z. B. „P2“), wenn ein bestehender Punkt gemeint ist'),
      targetHint: opt(z.string()).describe('Hinweis, welcher bestehende offene Punkt gemeint ist (nur, wenn keine ID passt)'),
      newStatus: opt(z.enum(['open', 'waiting', 'blocked', 'resolved', 'dismissed'])),
      resolutionNote: opt(z.string()).describe(
        'Nur beim Schließen: wie der Punkt gelöst wurde bzw. warum er sich erledigt hat, wenn der Benutzer es sagt (z. B. „Angebot von Müller angenommen“); sonst leer',
      ),
    }),
  ),
  event: opt(
    z.object({
      title: opt(z.string()),
      description: opt(z.string()),
      occurredAt: opt(z.string()).describe('ISO-Datum YYYY-MM-DD, an dem das Ereignis stattfand'),
      participants: opt(z.array(z.string())).describe('Beteiligte Personen, nur wenn im Text genannt (Namen wie geschrieben); sonst leer'),
    }),
  ),
  reminder: opt(
    z.object({
      remindAt: opt(z.string()).describe('Zeitpunkt der Erinnerung als ISO-Datum YYYY-MM-DD'),
      relativeText: opt(z.string()).describe('Die Zeitangabe wörtlich, z. B. „nächsten Montag“'),
      targetId: opt(z.string()).describe('ID des offenen Punkts aus dem Kontext (z. B. „P2“), an den erinnert werden soll'),
      targetHint: opt(z.string()).describe('Hinweis auf den offenen Punkt (nur, wenn keine ID passt)'),
      title: opt(z.string()).describe('Kurzer Titel: woran erinnert werden soll (Subjekt und Tätigkeit)'),
    }),
  ),
  proposalId: opt(z.string()).describe('Bei proposal_confirm/proposal_reject: ID des gemeinten Vorschlags aus dem Kontext (z. B. „V1“)'),
  path: opt(z.string()),
  note: opt(z.string()),
  decisionCertainty: opt(z.enum(['clear', 'unsure'])).describe(
    'Nur bei decision_new: clear = ausdrücklich getroffene Entscheidung; unsure = könnte auch Plan, Ereignis, Status oder Notiz sein',
  ),
  segment: opt(z.string()).describe('Der Teil der Nachricht, auf den sich diese Absicht bezieht'),
});
export type ChatIntent = z.infer<typeof ChatIntent>;

/** Result of the intent analysis: a message can contain several intents. */
export const ChatAnalysis = z.object({
  intents: z.array(ChatIntent).min(1).max(5),
  clarification: opt(z.string()).describe('Rückfrage an den Benutzer, wenn die Absicht unklar ist und nichts geraten werden soll'),
  saveAs: opt(z.enum(['decision', 'event', 'note', 'nothing'])).describe(
    'Nur als Antwort auf die offene Rückfrage „Entscheidung, Ereignis, Notiz oder nichts speichern?“; sonst null',
  ),
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
  documentDate: opt(z.string()).describe(
    'Datum des Dokuments selbst (Brief-, Sitzungs-, Rechnungs- oder Erstellungsdatum laut Text), YYYY-MM-DD; nicht das heutige Datum, leer wenn nicht erkennbar',
  ),
  tags: z.array(z.string()).default([]),
  location: ArchiveLocationProposal,
  decisions: z
    .array(
      z.object({
        title: z.string(),
        decisionText: z.string(),
        decidedAt: opt(z.string()),
        participants: z.array(z.string()).default([]),
        kind: opt(DecisionKind).describe(
          'decided = verbindlich entschieden/beschlossen; proposed = nur vorgeschlagen; discussed = nur besprochen; postponed = vertagt; rejected = ausdrücklich abgelehnt',
        ),
        evidence: opt(z.string()).describe('Der Satz aus dem Dokumenttext, der die Entscheidung belegt – wörtlich und unverändert kopiert'),
      }),
    )
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

/** LLM output for „Lösungsvorschlag generieren“ on an open item. */
export const SolutionProposal = z.object({
  assessment: z.string().describe('Kurze Einschätzung der Lage in 2–4 Sätzen'),
  assessmentSourceIds: z.array(z.string()).default([]).describe('Belege der Einschätzung, z. B. ["S1"]'),
  nextSteps: z
    .array(
      z.object({
        title: z.string().describe('Konkreter nächster Schritt, kurz – eignet sich als eigener offener Punkt'),
        detail: opt(z.string()),
        sourceIds: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  openQuestions: z.array(z.string()).default([]).describe('Offene Fragen bzw. fehlende Informationen'),
  risks: z.array(z.object({ description: z.string(), sourceIds: z.array(z.string()).default([]) })).default([]),
  usedSourceIds: z.array(z.string()).default([]),
  confidence: Confidence.default(0.6),
});
export type SolutionProposal = z.infer<typeof SolutionProposal>;
