import type { EntityRef, EntityType, GraphEntity } from '@archivist/shared';
import { and, eq, like, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { entities, insights as insightsTable } from '../../db/schema';
import { sha256Text } from '../../util/hash';
import { comparePersonNames, isNotAPersonName, type PersonNameRelation } from '../../util/person-names';
import { truncate } from '../../util/text';
import type { InsightChoiceSpec, InsightInput, InsightService } from '../insights';
import type { KnowledgeGraphService } from '../knowledge-graph';
import type { LlmService } from '../llm';
import type { PrivacyService } from '../privacy';

/** One pair question „Ist ‚A‘ dieselbe Person wie ‚B‘?“; the key holds the sorted ids, so the answer survives renames. */
export const PERSON_PAIR_KEY_PREFIX = 'person-same:';
/** One question „Welche Monika ist gemeint?“ for a short name with several candidates. */
export const PERSON_WHICH_KEY_PREFIX = 'person-which:';
const HINT_PREFIX = 'Hinweis des Sprachmodells: ';
/** Upper bound of questions sent to the LLM for a hint in one run. */
const MAX_LLM_QUESTIONS = 25;

type UnclearRelation = Exclude<PersonNameRelation, 'same'>;

const REASON: Record<UnclearRelation, (short: string, long: string) => string> = {
  first_name_only: (s, l) => `„${s}“ ist nur der Vorname von „${l}“.`,
  last_name_only: (s, l) => `„${s}“ ist nur der Nachname von „${l}“.`,
  initial: (s, l) => `„${s}“ kürzt einen Vornamen von „${l}“ mit einer Initiale ab.`,
  middle_name: (s, l) => `„${l}“ hat einen zweiten Vornamen, „${s}“ nicht.`,
  similar_spelling: (s, l) => `„${s}“ und „${l}“ werden sehr ähnlich geschrieben.`,
};

const pairKey = (a: string, b: string) => `${PERSON_PAIR_KEY_PREFIX}${[a, b].sort().join('|')}`;
const whichKey = (shortId: string, candidateIds: string[]) =>
  `${PERSON_WHICH_KEY_PREFIX}${shortId}:${sha256Text([...candidateIds].sort().join('|')).slice(0, 12)}`;

interface Person {
  id: string;
  name: string;
}

/** A question: either one candidate (pair) or several candidates for the same short name. */
interface Question {
  key: string;
  short: Person;
  candidates: Array<{ person: Person; relation: UnclearRelation }>;
}

interface Evidence {
  documents: number;
  decisions: number;
  topics: string[];
  references: number;
}

const LlmHints = z.object({
  questions: z.array(
    z.object({
      nr: z.number().int(),
      verdict: z.enum(['same', 'different', 'unclear']),
      /** for questions with several candidates: the name that is probably meant */
      candidate: z.string().nullish(),
      reason: z.string().nullish(),
    }),
  ),
});
const VERDICT_TEXT = { same: 'wahrscheinlich dieselbe Person', different: 'wahrscheinlich verschiedene Personen', unclear: 'unklar' } as const;

const counted = (n: number, [one, many]: [string, string]) => `${n} ${n === 1 ? one : many}`;

export interface PersonQuestionServiceDeps {
  ctx: AppContext;
  graph: KnowledgeGraphService;
  insights: InsightService;
  llm: LlmService;
  privacy: PrivacyService;
}

/** Archive check step: asks instead of guessing when two person entries might be the same person; answers are remembered. */
export class PersonQuestionService {
  private readonly ctx: AppContext;
  private readonly graph: KnowledgeGraphService;
  private readonly insights: InsightService;
  private readonly llm: LlmService;
  private readonly privacy: PrivacyService;

  constructor(deps: PersonQuestionServiceDeps) {
    ({ ctx: this.ctx, graph: this.graph, insights: this.insights, llm: this.llm, privacy: this.privacy } = deps);
  }

  private get db() {
    return this.ctx.database.db;
  }

  async check(count: (kind: string, n?: number) => void, signal?: AbortSignal): Promise<void> {
    const persons = this.db
      .select({ id: entities.id, name: entities.name })
      .from(entities)
      .where(eq(entities.type, 'person'))
      // insertion order: for similar spellings the newer entry is the one asked about
      .orderBy(sql`rowid`)
      .all()
      .filter((p) => !isNotAPersonName(p.name));
    const exists = new Set(persons.map((p) => p.id));
    const different = this.differentPairs(exists);
    const questions = this.questions(persons, different);

    // answers stay remembered for as long as both entries exist, even if the names no longer look alike
    const current = new Set<string>([...different.keys].filter((k) => k.startsWith(PERSON_PAIR_KEY_PREFIX)));
    const fresh: Question[] = [];
    const known: Question[] = [];
    for (const q of questions) {
      current.add(q.key);
      const existing = this.insights.byDedupeKey(q.key);
      if (existing?.status === 'rejected') continue;
      (existing ? known : fresh).push(q);
    }
    const hints = await this.llmHints(fresh, signal);
    signal?.throwIfAborted();
    for (const q of known) if (this.insights.upsert(this.describe(q, null)).status === 'open') count('unclear_person');
    for (const [i, q] of fresh.entries()) if (this.insights.upsert(this.describe(q, hints.get(i) ?? null)).status === 'open') count('unclear_person');
    this.insights.reconcile(PERSON_PAIR_KEY_PREFIX, current);
    this.insights.reconcile(PERSON_WHICH_KEY_PREFIX, current);
  }

  /** Pairs answered „verschieden“; a rejected „Welche …?“ question is stored per candidate so the answer outlives it. */
  private differentPairs(exists: Set<string>): { has: (a: string, b: string) => boolean; keys: Set<string> } {
    const rejected = (prefix: string) =>
      this.db
        .select()
        .from(insightsTable)
        .where(and(like(insightsTable.dedupeKey, `${prefix}%`), eq(insightsTable.status, 'rejected')))
        .all();
    const keys = new Set<string>();
    for (const r of rejected(PERSON_WHICH_KEY_PREFIX)) {
      const [shortId, ...candidateIds] = r.sourceIds;
      if (!shortId) continue;
      for (const c of candidateIds) {
        const key = pairKey(shortId, c);
        if (this.insights.byDedupeKey(key)) continue;
        this.insights.upsert({
          kind: 'unclear_person',
          title: r.title,
          explanation: 'Als verschiedene Personen beantwortet („keine davon“).',
          confidence: 0.5,
          sourceIds: [shortId, c],
          dedupeKey: key,
        });
        this.insights.settle(key, 'rejected', 'Als verschiedene Personen beantwortet.');
      }
    }
    for (const r of rejected(PERSON_PAIR_KEY_PREFIX)) if (r.sourceIds.length === 2 && r.sourceIds.every((id) => exists.has(id))) keys.add(r.dedupeKey);
    return { has: (a, b) => keys.has(pairKey(a, b)), keys };
  }

  /** Unclear pairs; a short name that may mean several persons becomes one question with all candidates. */
  private questions(persons: Person[], different: { has: (a: string, b: string) => boolean }): Question[] {
    const shortFor = new Map<string, Array<{ person: Person; relation: UnclearRelation }>>();
    const pairs: Question[] = [];
    for (let i = 0; i < persons.length; i += 1) {
      for (let j = i + 1; j < persons.length; j += 1) {
        const a = persons[i]!;
        const b = persons[j]!;
        const relation = comparePersonNames(a.name, b.name);
        if (!relation || relation === 'same' || different.has(a.id, b.id)) continue;
        if (relation === 'similar_spelling') {
          pairs.push({ key: pairKey(a.id, b.id), short: b, candidates: [{ person: a, relation }] });
          continue;
        }
        // the shorter spelling (fewer parts, or an initial instead of a first name) is the unclear one
        const size = (p: Person) => p.name.split(/\s+/).length * 1000 + p.name.replace(/[^\p{L}]/gu, '').length;
        const [short, long] = size(a) < size(b) ? [a, b] : [b, a];
        shortFor.set(short.id, [...(shortFor.get(short.id) ?? []), { person: long, relation }]);
      }
    }
    const byId = new Map(persons.map((p) => [p.id, p]));
    for (const [shortId, candidates] of shortFor) {
      const short = byId.get(shortId)!;
      const key =
        candidates.length === 1
          ? pairKey(shortId, candidates[0]!.person.id)
          : whichKey(
              shortId,
              candidates.map((c) => c.person.id),
            );
      pairs.push({ key, short, candidates });
    }
    return pairs;
  }

  private evidence(id: string): Evidence {
    const neighbors = this.graph.neighbors(id);
    const of = (t: EntityType) => neighbors.filter((n) => n.type === t);
    return {
      documents: of('document').length,
      decisions: of('decision').length,
      topics: [...of('topic'), ...of('project')].map((n) => n.name),
      references: neighbors.length,
    };
  }

  private sharedEvidence(a: string, b: string): string {
    const neighborsA = this.graph.neighbors(a);
    const neighborIdsB = new Set(this.graph.neighbors(b).map((n) => n.id));
    const shared: GraphEntity[] = neighborsA.filter((n) => neighborIdsB.has(n.id));
    const docs = shared.filter((n) => n.type === 'document').length;
    const decisions = shared.filter((n) => n.type === 'decision').length;
    const topics = shared.filter((n) => n.type === 'topic' || n.type === 'project').map((n) => `„${n.name}“`);
    const parts = [
      docs ? counted(docs, ['gemeinsames Dokument', 'gemeinsame Dokumente']) : null,
      decisions ? counted(decisions, ['gemeinsame Entscheidung', 'gemeinsame Entscheidungen']) : null,
      topics.length ? `gemeinsame Themen/Projekte: ${topics.join(', ')}` : null,
    ].filter(Boolean);
    return parts.length ? parts.join(', ') : 'keine gemeinsamen Dokumente, Entscheidungen oder Themen';
  }

  private describeEvidence(e: Evidence): string {
    const parts = [counted(e.documents, ['Dokument', 'Dokumente']), counted(e.decisions, ['Entscheidung', 'Entscheidungen'])];
    if (e.topics.length) parts.push(`Themen/Projekte: ${e.topics.slice(0, 5).join(', ')}`);
    return parts.join(', ');
  }

  private describe(q: Question, hint: string | null): InsightInput {
    const ref = (p: Person): EntityRef => ({ type: 'person', id: p.id, label: p.name, detail: this.describeEvidence(this.evidence(p.id)) });
    const previousHint = this.insights
      .byDedupeKey(q.key)
      ?.explanation.split('\n')
      .find((l) => l.startsWith(HINT_PREFIX));
    const hintLine = hint ? `${HINT_PREFIX}${hint}` : previousHint;
    const affected = [ref(q.short), ...q.candidates.map((c) => ref(c.person))];
    const merge = (source: Person, target: Person): InsightChoiceSpec['proposal'] => ({
      actionType: 'merge_entities',
      label: `„${source.name}“ mit „${target.name}“ zusammenführen`,
      rationale: `Beantwortet: „${source.name}“ ist dieselbe Person wie „${target.name}“.`,
      confidence: 0.9,
      affectedEntities: [ref(source), ref(target)],
      requiredConfirmation: 'confirm',
      proposedParameters: { sourceIds: [source.id], targetId: target.id, allowCrossType: false },
    });
    const evidenceLines = [q.short, ...q.candidates.map((c) => c.person)].map((p) => `• „${p.name}“: ${this.describeEvidence(this.evidence(p.id))}`);

    if (q.candidates.length === 1) {
      const { person: other, relation } = q.candidates[0]!;
      // the short name goes into the complete one; for similar spellings the entry with more references stays
      const [source, target] =
        relation !== 'similar_spelling' || this.evidence(q.short.id).references > this.evidence(other.id).references ? [q.short, other] : [other, q.short];
      const explanation = [
        `Verdacht: ${REASON[relation](q.short.name, other.name)}`,
        '',
        'Belege:',
        ...evidenceLines,
        `• Gemeinsam: ${this.sharedEvidence(q.short.id, other.id)}`,
        '',
        `„Gleich“ führt „${source.name}“ mit „${target.name}“ zusammen (rückgängig machbar, „${source.name}“ bleibt als andere Schreibweise erhalten). „Verschieden“ merkt sich dauerhaft, dass es zwei Personen sind. „Später erinnern“ stellt die Frage zurück.`,
        ...(hintLine ? ['', hintLine] : []),
      ].join('\n');
      return {
        kind: 'unclear_person',
        title: `Ist „${q.short.name}“ dieselbe Person wie „${other.name}“?`,
        explanation,
        confidence: 0.5,
        affected,
        sourceIds: [q.short.id, other.id],
        choices: [
          {
            id: 'same',
            label: 'Gleich',
            description: `„${source.name}“ und „${target.name}“ werden zu „${target.name}“ zusammengeführt.`,
            proposal: merge(source, target),
          },
          { id: 'different', label: 'Verschieden', description: 'Beide bleiben getrennt. Diese Frage wird nicht erneut gestellt.' },
        ],
        dedupeKey: q.key,
      };
    }

    const explanation = [
      `Verdacht: „${q.short.name}“ kann mehrere Personen meinen.`,
      ...q.candidates.map((c) => `• ${REASON[c.relation](q.short.name, c.person.name)} Gemeinsam: ${this.sharedEvidence(q.short.id, c.person.id)}`),
      '',
      'Belege:',
      ...evidenceLines,
      '',
      `Die gewählte Person übernimmt „${q.short.name}“ als andere Schreibweise (rückgängig machbar). „Keine davon“ merkt sich, dass „${q.short.name}“ keine dieser Personen ist.`,
      ...(hintLine ? ['', hintLine] : []),
    ].join('\n');
    return {
      kind: 'unclear_person',
      title: `Welche ${q.short.name} ist gemeint?`,
      explanation,
      confidence: 0.4,
      affected,
      sourceIds: [q.short.id, ...q.candidates.map((c) => c.person.id)],
      choices: [
        ...q.candidates.map((c) => ({
          id: c.person.id,
          label: c.person.name,
          description: `„${q.short.name}“ wird mit „${c.person.name}“ zusammengeführt.`,
          proposal: merge(q.short, c.person),
        })),
        { id: 'none', label: 'Keine davon', description: `„${q.short.name}“ bleibt eine eigene Person. Diese Frage wird nicht erneut gestellt.` },
      ],
      dedupeKey: q.key,
    };
  }

  /** Optional LLM hint (names only, privacy mode „auto“ only: nobody can confirm a background run) that never decides. */
  private async llmHints(questions: Question[], signal?: AbortSignal): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    if (questions.length === 0 || this.privacy.mode() !== 'auto' || !this.llm.canUse()) return out;
    const batch = questions.slice(0, MAX_LLM_QUESTIONS);
    try {
      const answer = await this.llm.completeJson(LlmHints, {
        schemaName: 'PersonHints',
        purpose: 'Personen-Rückfragen (nur Namen)',
        signal,
        instructions:
          'Du prüfst Namen von Personen aus einem persönlichen Wissensarchiv. Gib für jede Frage an, ob der erste Name wahrscheinlich dieselbe Person meint wie der (bzw. einer der) weiteren ("same"), verschiedene Personen ("different") oder ob das unklar ist ("unclear"); bei mehreren Kandidaten nenne in "candidate" den wahrscheinlich gemeinten Namen. Begründe kurz auf Deutsch. Du entscheidest nichts, der Benutzer entscheidet. Sprichst du den Benutzer an, dann mit „du“.',
        input: batch.map((q, i) => `${i + 1}. „${q.short.name}“ / ${q.candidates.map((c) => `„${c.person.name}“`).join(' / ')}`).join('\n'),
      });
      for (const h of answer.questions) {
        if (h.nr < 1 || h.nr > batch.length) continue;
        const candidate = h.candidate?.trim() ? ` (${truncate(h.candidate.trim(), 80)})` : '';
        out.set(h.nr - 1, `${VERDICT_TEXT[h.verdict]}${candidate}${h.reason?.trim() ? ` – ${truncate(h.reason.trim(), 200)}` : ''}`);
      }
    } catch (err) {
      this.ctx.logger.warn('consistency', 'LLM hint on unclear persons unavailable', { error: err });
    }
    return out;
  }
}
