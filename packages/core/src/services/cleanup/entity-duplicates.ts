import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { decisions, documents, entities, events, openItems, relations } from '../../db/schema';
import { normalizeName, truncate } from '../../util/text';
import type { ActionService } from '../actions';
import type { InsightInput, InsightService } from '../insights';
import type { LlmService } from '../llm';
import type { PrivacyService } from '../privacy';
import {
  CHECKED_TYPES,
  duplicateInsight,
  HINT_PREFIX,
  isPreferredTarget,
  TYPE_LABEL,
  type Candidate,
  type CheckedType,
  type Evidence,
  type Found,
} from './entity-duplicate-insight';
import { classifyNames } from './entity-name-matching';

/** Dedupe key prefix: `similar-entities:<id>|<id>` (sorted ids), stable across renames. */
const KEY_PREFIX = 'similar-entities:';
/** Key prefix of the former topic-only check; its open insights are retired, its rejections still count. */
const LEGACY_KEY_PREFIX = 'similar-topics:';
/** Upper bound of pairs sent to the LLM for a hint in one run. */
const MAX_LLM_PAIRS = 25;

const LlmHints = z.object({
  pairs: z.array(
    z.object({
      nr: z.number().int(),
      verdict: z.enum(['same', 'different', 'unclear']),
      reason: z.string().nullish(),
    }),
  ),
});

const VERDICT_TEXT: Record<'same' | 'different' | 'unclear', string> = {
  same: 'wahrscheinlich dasselbe',
  different: 'wahrscheinlich verschieden',
  unclear: 'unklar',
};

const HINT_INSTRUCTIONS =
  'Du prüfst Paare von Namen aus einem persönlichen Wissensarchiv (Themen, Projekte, Tags). Gib für jedes Paar an, ob beide Namen wahrscheinlich dasselbe meinen ("same"), verschiedene Dinge ("different") oder ob das unklar ist ("unclear"), mit einer kurzen deutschen Begründung. Du entscheidest nichts, der Benutzer entscheidet. Sprichst du den Benutzer an, dann mit „du“.';

/** Duplicate insight key for a pair of entities: kind prefix plus sorted ids (never names or scores). */
export function duplicateKey(ids: string[]): string {
  return `${KEY_PREFIX}${[...ids].sort().join('|')}`;
}

export interface EntityDuplicateCheckDeps {
  ctx: AppContext;
  insights: InsightService;
  actions: ActionService;
  llm: LlmService;
  privacy: PrivacyService;
}

/** Archive check: asks via an insight about topics, projects and tags that are probably the same; nothing merges by itself. */
export class EntityDuplicateCheck {
  private readonly ctx: AppContext;
  private readonly insights: InsightService;
  private readonly actions: ActionService;
  private readonly llm: LlmService;
  private readonly privacy: PrivacyService;

  constructor(deps: EntityDuplicateCheckDeps) {
    ({ ctx: this.ctx, insights: this.insights, actions: this.actions, llm: this.llm, privacy: this.privacy } = deps);
  }

  private tagDocCounts: Map<string, number> | null = null;

  private get db() {
    return this.ctx.database.db;
  }

  /** Runs the check (one `count` per open question); `signal` cancels it before the questions are written. */
  async run(count: (kind: string) => void, signal?: AbortSignal): Promise<void> {
    this.tagDocCounts = null;
    const keys = new Set<string>();
    const fresh: Found[] = [];
    const known: Found[] = [];
    for (const found of CHECKED_TYPES.flatMap((type) => this.candidates(type))) {
      keys.add(found.key);
      const existing = this.insights.byDedupeKey(found.key);
      if (existing?.status === 'rejected') continue; // „Verschieden“
      if (!existing && this.rejectedByLegacyCheck(found)) this.carryOverLegacyAnswer(found);
      else (existing ? known : fresh).push(found);
    }
    const hints = await this.llmHints(fresh, signal);
    signal?.throwIfAborted();
    const ask = (found: Found, hint: string | null) => {
      if (this.insights.upsert(this.describe(found, hint)).status === 'open') count('similar_entities');
    };
    for (const found of known) ask(found, null);
    for (const [i, found] of fresh.entries()) ask(found, hints.get(i) ?? null);
    // the former topic-only check is replaced: its questions (and merge_topics proposals) are closed
    this.insights.reconcile(LEGACY_KEY_PREFIX, new Set());
    this.insights.reconcile(KEY_PREFIX, keys);
  }

  /** A „different“ answered in the former topic-only check is carried over to the new key. */
  private carryOverLegacyAnswer(found: Found): void {
    this.insights.upsert({ ...this.describe(found, null), action: undefined });
    this.insights.settle(found.key, { status: 'rejected', reason: 'Bereits in der früheren Themen-Prüfung als verschieden markiert.' });
  }

  private candidates(type: CheckedType): Found[] {
    const list: Candidate[] = this.db
      .select({ id: entities.id, name: entities.name, aliases: entities.aliases, createdAt: entities.createdAt })
      .from(entities)
      .where(eq(entities.type, type))
      .all()
      .map((row) => ({ ...row, type }));
    const out: Found[] = [];
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const [a, b] = [list[i]!, list[j]!];
        const match = classifyNames(a, b);
        // one already below the other (#282) is no duplicate
        if (match && !this.subtopicLinked(a.id, b.id)) out.push({ key: duplicateKey([a.id, b.id]), type, a, b, match });
      }
    }
    return out;
  }

  private subtopicLinked(a: string, b: string): boolean {
    return Boolean(
      this.ctx.database.sqlite
        .prepare(
          `SELECT 1 FROM relations WHERE relation_type = 'subtopic_of' AND status = 'confirmed' AND ((source_entity_id = ? AND target_entity_id = ?) OR (source_entity_id = ? AND target_entity_id = ?)) LIMIT 1`,
        )
        .get(a, b, b, a),
    );
  }

  private rejectedByLegacyCheck(found: Found): boolean {
    if (found.type !== 'topic') return false;
    return this.insights.byDedupeKey(`${LEGACY_KEY_PREFIX}${[found.a.id, found.b.id].sort().join('|')}`)?.status === 'rejected';
  }

  /** Number of documents per normalized tag name (computed once per run). */
  private tagDocs(): Map<string, number> {
    if (this.tagDocCounts) return this.tagDocCounts;
    const out = new Map<string, number>();
    this.tagDocCounts = out;
    const rows = this.db
      .select({ tags: documents.tags })
      .from(documents)
      .where(sql`${documents.tags} != '[]'`)
      .all();
    for (const row of rows) for (const tag of new Set(row.tags.map(normalizeName))) out.set(tag, (out.get(tag) ?? 0) + 1);
    return out;
  }

  private evidence(candidate: Candidate, tagDocs: Map<string, number>): Evidence {
    const relationCount =
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(relations)
        .where(
          and(or(eq(relations.sourceEntityId, candidate.id), eq(relations.targetEntityId, candidate.id)), inArray(relations.status, ['proposed', 'confirmed'])),
        )
        .get()?.count ?? 0;
    if (candidate.type === 'tag')
      return { documents: tagDocs.get(normalizeName(candidate.name)) ?? 0, decisions: 0, openItems: 0, events: 0, relations: relationCount };
    const references = (table: typeof documents | typeof decisions | typeof openItems | typeof events) =>
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(table)
        .where(or(eq(table.topicId, candidate.id), eq(table.projectId, candidate.id)))
        .get()?.count ?? 0;
    return {
      documents: references(documents),
      decisions: references(decisions),
      openItems: references(openItems),
      events: references(events),
      relations: relationCount,
    };
  }

  /** Target of an already proposed, still open merge action of this pair (kept stable across runs). */
  private existingTarget(found: Found): string | null {
    const actionId = this.insights.byDedupeKey(found.key)?.recommendedActionId;
    if (!actionId) return null;
    const action = this.actions.getMany([actionId])[0];
    const parameters = action?.proposedParameters as { targetId?: string; sourceIds?: string[] } | undefined;
    if (action?.status !== 'proposed' || action.actionType !== 'merge_entities' || !parameters?.targetId) return null;
    const ids = new Set([found.a.id, found.b.id]);
    return ids.has(parameters.targetId) && parameters.sourceIds?.length === 1 && ids.has(parameters.sourceIds[0]!) ? parameters.targetId : null;
  }

  private describe(found: Found, hint: string | null): InsightInput {
    const tagDocs = this.tagDocs();
    const evidence = { a: this.evidence(found.a, tagDocs), b: this.evidence(found.b, tagDocs) };
    const preferA = isPreferredTarget({ candidate: found.a, evidence: evidence.a }, { candidate: found.b, evidence: evidence.b });
    const targetId = this.existingTarget(found) ?? (preferA ? found.a.id : found.b.id);
    const previousHint = this.insights
      .byDedupeKey(found.key)
      ?.explanation.split('\n')
      .find((line) => line.startsWith(HINT_PREFIX));
    return duplicateInsight({ found, evidence, targetId, hintLine: hint ? `${HINT_PREFIX}${hint}` : previousHint });
  }

  /** Optional LLM hint (names only, privacy mode „auto“ only) for new pairs; it never decides, failures are ignored. */
  private async llmHints(found: Found[], signal?: AbortSignal): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    if (found.length === 0 || this.privacy.mode() !== 'auto' || !this.llm.canUse()) return out;
    const batch = found.slice(0, MAX_LLM_PAIRS);
    try {
      const answer = await this.llm.completeJson(LlmHints, {
        schemaName: 'DuplicateHints',
        purpose: 'Dublettenprüfung (nur Namen)',
        signal,
        instructions: HINT_INSTRUCTIONS,
        input: batch.map((pair, i) => `${i + 1}. ${TYPE_LABEL[pair.type]}: „${pair.a.name}“ / „${pair.b.name}“`).join('\n'),
      });
      for (const pair of answer.pairs) {
        if (pair.nr < 1 || pair.nr > batch.length) continue;
        out.set(pair.nr - 1, `${VERDICT_TEXT[pair.verdict]}${pair.reason?.trim() ? ` – ${truncate(pair.reason.trim(), 200)}` : ''}`);
      }
    } catch (err) {
      this.ctx.logger.warn('consistency', 'LLM hint on possible duplicates unavailable', { error: err });
    }
    return out;
  }
}
