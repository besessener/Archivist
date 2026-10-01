import type { EntityRef } from '@archivist/shared';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { decisions, documents, entities, events, openItems, relations } from '../../db/schema';
import { normalizeName, truncate } from '../../util/text';
import type { ActionService } from '../actions';
import type { InsightService } from '../insights';
import type { LlmService } from '../llm';
import type { PrivacyService } from '../privacy';

/** Entity types checked for duplicates. Persons have their own check; topic↔project pairs are a separate story. */
const CHECKED_TYPES = ['topic', 'project', 'tag'] as const;
type CheckedType = (typeof CHECKED_TYPES)[number];

/** Dedupe key prefix: `similar-entities:<id>|<id>` (sorted ids), stable across renames. */
const KEY_PREFIX = 'similar-entities:';
/** Key prefix of the former topic-only check; its open insights are retired, its rejections still count. */
const LEGACY_KEY_PREFIX = 'similar-topics:';
const HINT_PREFIX = 'Hinweis des Sprachmodells: ';
/** Upper bound of pairs sent to the LLM for a hint in one run. */
const MAX_LLM_PAIRS = 25;

const TYPE_LABEL: Record<CheckedType, string> = { topic: 'Thema', project: 'Projekt', tag: 'Tag' };
const TYPE_PLURAL: Record<CheckedType, string> = { topic: 'Themen', project: 'Projekte', tag: 'Tags' };

/** How two names are related, from most to least certain. */
export type DuplicateMatch = 'alias' | 'spelling' | 'plural' | 'typo' | 'prefix';

const MATCH_CONFIDENCE: Record<DuplicateMatch, number> = { alias: 0.95, spelling: 0.9, plural: 0.85, typo: 0.7, prefix: 0.45 };

/** German/English plural endings appended to the singular (umlauts are compared without diacritics). */
const PLURAL_SUFFIXES = new Set(['e', 'n', 'en', 'er', 's', 'es', 'nen']);

interface NameForms {
  /** Normalized name (see `normalizeName`). */
  plain: string;
  tokens: string[];
  /** Name without separators: once with stripped diacritics (ü → u), once transliterated (ü → ue). */
  compacts: string[];
  digits: string;
}

/** Forms are computed once per name: a run compares every pair of names of a type. */
const formsCache = new Map<string, NameForms>();

function forms(name: string): NameForms {
  let f = formsCache.get(name);
  if (!f) {
    if (formsCache.size > 10_000) formsCache.clear();
    f = computeForms(name);
    formsCache.set(name, f);
  }
  return f;
}

function computeForms(name: string): NameForms {
  const lower = name.toLowerCase();
  const plain = normalizeName(lower);
  const translit = normalizeName(lower.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue'));
  return {
    plain,
    tokens: plain.split(' ').filter(Boolean),
    compacts: [...new Set([plain.replace(/ /g, ''), translit.replace(/ /g, '')])],
    digits: (plain.match(/\d+/g) ?? []).join(' '),
  };
}

/** Optimal string alignment distance (Levenshtein plus swapped neighbours), capped early by length difference. */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j += 1) d[0]![j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

const pairs = <T>(xs: T[], ys: T[]): Array<[T, T]> => xs.flatMap((x) => ys.map((y): [T, T] => [x, y]));

function isPlural(x: string, y: string): boolean {
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  if (s.length < 3) return false;
  if (l.startsWith(s) && PLURAL_SUFFIXES.has(l.slice(s.length))) return true;
  return s.endsWith('y') && l === `${s.slice(0, -1)}ies`;
}

/** Edits tolerated as a typo: none for short words, one from 6 letters, two from 11. */
function withinTypoLimit(x: string, y: string): boolean {
  const longest = Math.max(x.length, y.length);
  const allowed = longest >= 11 ? 2 : longest >= 6 ? 1 : 0;
  return allowed > 0 && Math.abs(x.length - y.length) <= allowed && editDistance(x, y) <= allowed;
}

/**
 * Names with the same number of words are compared word by word, so a short differing word („Gruppe A“ / „Gruppe B“,
 * „Standort Köln“ / „Standort Bonn“) is not a typo; otherwise the names are compared without separators.
 */
function isTypo(a: NameForms, b: NameForms): boolean {
  if (a.tokens.length > 1 && a.tokens.length === b.tokens.length) {
    const diff = a.tokens.map((t, i) => [t, b.tokens[i]!] as const).filter(([x, y]) => x !== y);
    return diff.length > 0 && diff.every(([x, y]) => withinTypoLimit(x, y));
  }
  return pairs(a.compacts, b.compacts).some(([x, y]) => withinTypoLimit(x, y));
}

/** „Urlaub“ ↔ „Urlaub 2026“: the shorter name is the start of the longer one (one or two more words). */
function isPrefix(a: NameForms, b: NameForms): boolean {
  const [s, l] = a.tokens.length <= b.tokens.length ? [a, b] : [b, a];
  const extra = l.tokens.length - s.tokens.length;
  if (extra < 1 || extra > 2 || s.tokens.join('').length < 4) return false;
  return s.tokens.every((t, i) => l.tokens[i] === t);
}

/**
 * Classifies two names of the same entity type as possible duplicates, or returns null. Names with different numbers
 * („Phase 1“ / „Phase 2“) are only ever a prefix case („Urlaub“ / „Urlaub 2026“).
 */
export function classifyNames(a: { name: string; aliases?: string[] }, b: { name: string; aliases?: string[] }): DuplicateMatch | null {
  const fa = forms(a.name);
  const fb = forms(b.name);
  const [na, nb] = [fa.plain, fb.plain];
  if (!na || !nb) return null;
  if ((b.aliases ?? []).some((x) => normalizeName(x) === na) || (a.aliases ?? []).some((x) => normalizeName(x) === nb)) return 'alias';
  if (fa.digits === fb.digits) {
    if (na === nb || pairs(fa.compacts, fb.compacts).some(([x, y]) => x === y)) return 'spelling';
    if (fa.tokens.length > 1 && [...fa.tokens].sort().join(' ') === [...fb.tokens].sort().join(' ')) return 'spelling';
    if (pairs(fa.compacts, fb.compacts).some(([x, y]) => isPlural(x, y))) return 'plural';
    if (isTypo(fa, fb)) return 'typo';
  }
  return isPrefix(fa, fb) ? 'prefix' : null;
}

/** Duplicate insight key for a pair of entities: kind prefix plus sorted ids (never names or scores). */
export function duplicateKey(ids: string[]): string {
  return `${KEY_PREFIX}${[...ids].sort().join('|')}`;
}

interface Candidate {
  id: string;
  type: CheckedType;
  name: string;
  aliases: string[];
  createdAt: string;
}

interface Evidence {
  documents: number;
  decisions: number;
  openItems: number;
  events: number;
  relations: number;
}

const referenceCount = (e: Evidence) => e.documents + e.decisions + e.openItems + e.events;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function describeEvidence(e: Evidence): string {
  const parts = [
    e.documents && plural(e.documents, 'Dokument', 'Dokumente'),
    e.decisions && plural(e.decisions, 'Entscheidung', 'Entscheidungen'),
    e.openItems && plural(e.openItems, 'offener Punkt', 'offene Punkte'),
    e.events && plural(e.events, 'Ereignis', 'Ereignisse'),
  ].filter(Boolean);
  if (parts.length === 0) return e.relations ? plural(e.relations, 'Verknüpfung', 'Verknüpfungen') : 'keine Verweise';
  return parts.join(', ');
}

/** Name quality for choosing the merge target when both are referenced equally often. */
function nameQuality(name: string): number {
  let q = 0;
  if (/\p{Lu}/u.test(name)) q += 1; // „Urlaub“ rather than „urlaub“
  if (/[äöüÄÖÜß]/.test(name)) q += 1; // real umlauts rather than „ae/oe/ue“
  if (/_|\s{2,}|^\s|\s$/.test(name)) q -= 1;
  return q;
}

const MATCH_TEXT: Record<DuplicateMatch, (a: string, b: string) => string> = {
  alias: (a, b) => `„${a}“ ist bereits als anderer Name von „${b}“ bekannt.`,
  spelling: () => 'Die Namen unterscheiden sich nur in der Schreibweise (Bindestrich, Leerzeichen, Groß-/Kleinschreibung, Umlaute oder Wortreihenfolge).',
  plural: () => 'Die Namen unterscheiden sich nur in Singular und Plural.',
  typo: () => 'Die Namen unterscheiden sich nur um einen Tippfehler.',
  prefix: (a, b) => `„${b}“ beginnt mit „${a}“. Das kann dasselbe sein oder ein eigener Teilbereich – bitte entscheide.`,
};

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

interface Found {
  key: string;
  type: CheckedType;
  a: Candidate;
  b: Candidate;
  match: DuplicateMatch;
}

/**
 * Archive check: finds topics, projects and tags that are probably the same (spelling variants, singular/plural,
 * typos, prefix cases) and asks the user via an insight with the recommended action `merge_entities`. Nothing is
 * merged automatically; rejecting the insight („Verschieden“) is remembered permanently through its dedupe key.
 */
export class EntityDuplicateCheck {
  constructor(
    private readonly ctx: AppContext,
    private readonly insights: InsightService,
    private readonly actions: ActionService,
    private readonly llm: LlmService,
    private readonly privacy: PrivacyService,
  ) {}

  private get db() {
    return this.ctx.database.db;
  }

  /** Runs the check; `count` receives one call per newly created insight. */
  async run(count: (kind: string) => void): Promise<void> {
    // the former topic-only check is replaced: its pending questions would duplicate the new ones
    this.insights.retirePending(LEGACY_KEY_PREFIX, new Set(), 'Zurückgezogen: ersetzt durch die gemeinsame Dublettenprüfung.');

    const keep = new Set<string>();
    const fresh: Found[] = [];
    const refresh: Found[] = [];
    for (const type of CHECKED_TYPES) {
      for (const found of this.candidates(type)) {
        const existing = this.insights.byDedupeKey(found.key);
        if (existing && existing.status !== 'open' && existing.status !== 'snoozed') continue; // accepted, or „Verschieden“
        if (!existing && this.rejectedByLegacyCheck(found)) continue;
        keep.add(found.key);
        if (!existing) fresh.push(found);
        else if (existing.status === 'open') refresh.push(found); // a snoozed question stays as it is until it is due
      }
    }
    // pairs whose entities were merged, renamed or deleted in the meantime
    this.insights.retirePending(KEY_PREFIX, keep);

    const tagDocs = this.tagDocumentCounts();
    for (const f of refresh) this.upsert(f, tagDocs, null);
    const hints = await this.llmHints(fresh);
    for (const [i, f] of fresh.entries()) {
      this.upsert(f, tagDocs, hints.get(i) ?? null);
      count('similar_entities');
    }
  }

  private candidates(type: CheckedType): Found[] {
    const list: Candidate[] = this.db
      .select({ id: entities.id, name: entities.name, aliases: entities.aliases, createdAt: entities.createdAt })
      .from(entities)
      .where(eq(entities.type, type))
      .all()
      .map((r) => ({ ...r, type }));
    const out: Found[] = [];
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const [a, b] = [list[i]!, list[j]!];
        const match = classifyNames(a, b);
        if (match) out.push({ key: duplicateKey([a.id, b.id]), type, a, b, match });
      }
    }
    return out;
  }

  private rejectedByLegacyCheck(f: Found): boolean {
    if (f.type !== 'topic') return false;
    return this.insights.byDedupeKey(`${LEGACY_KEY_PREFIX}${[f.a.id, f.b.id].sort().join('|')}`)?.status === 'rejected';
  }

  /** Number of documents per normalized tag name. */
  private tagDocumentCounts(): Map<string, number> {
    const out = new Map<string, number>();
    const rows = this.db
      .select({ tags: documents.tags })
      .from(documents)
      .where(sql`${documents.tags} != '[]'`)
      .all();
    for (const r of rows) for (const t of new Set(r.tags.map(normalizeName))) out.set(t, (out.get(t) ?? 0) + 1);
    return out;
  }

  private evidence(e: Candidate, tagDocs: Map<string, number>): Evidence {
    const rel =
      this.db
        .select({ c: sql<number>`count(*)` })
        .from(relations)
        .where(and(or(eq(relations.sourceEntityId, e.id), eq(relations.targetEntityId, e.id)), inArray(relations.status, ['proposed', 'confirmed'])))
        .get()?.c ?? 0;
    if (e.type === 'tag') return { documents: tagDocs.get(normalizeName(e.name)) ?? 0, decisions: 0, openItems: 0, events: 0, relations: rel };
    const n = (tbl: typeof documents | typeof decisions | typeof openItems | typeof events) =>
      this.db
        .select({ c: sql<number>`count(*)` })
        .from(tbl)
        .where(or(eq(tbl.topicId, e.id), eq(tbl.projectId, e.id)))
        .get()?.c ?? 0;
    return { documents: n(documents), decisions: n(decisions), openItems: n(openItems), events: n(events), relations: rel };
  }

  /** Target = the entity with more references; on a tie the cleaner, then shorter, then older name. */
  private chooseTarget(a: Candidate, b: Candidate, ea: Evidence, eb: Evidence): boolean {
    const keys = (c: Candidate, e: Evidence) => [referenceCount(e), e.relations, nameQuality(c.name), -c.name.length];
    const ka = keys(a, ea);
    const kb = keys(b, eb);
    for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i]) return ka[i]! > kb[i]!;
    return a.createdAt === b.createdAt ? a.id < b.id : a.createdAt < b.createdAt;
  }

  /** Direction of an already proposed, still open merge action of this pair (kept stable across runs). */
  private existingDirection(f: Found): { actionId: string; targetId: string } | null {
    const actionId = this.insights.byDedupeKey(f.key)?.recommendedActionId;
    if (!actionId) return null;
    const action = this.actions.getMany([actionId])[0];
    const p = action?.proposedParameters as { targetId?: string; sourceIds?: string[] } | undefined;
    if (action?.status !== 'proposed' || action.actionType !== 'merge_entities' || !p?.targetId) return null;
    const ids = new Set([f.a.id, f.b.id]);
    return ids.has(p.targetId) && p.sourceIds?.length === 1 && ids.has(p.sourceIds[0]!) ? { actionId, targetId: p.targetId } : null;
  }

  private upsert(f: Found, tagDocs: Map<string, number>, hint: string | null): void {
    const ea = this.evidence(f.a, tagDocs);
    const eb = this.evidence(f.b, tagDocs);
    const existing = this.existingDirection(f);
    const aIsTarget = existing ? existing.targetId === f.a.id : this.chooseTarget(f.a, f.b, ea, eb);
    const [target, source] = aIsTarget ? [f.a, f.b] : [f.b, f.a];
    const [et, es] = aIsTarget ? [ea, eb] : [eb, ea];
    const label = TYPE_LABEL[f.type];
    const ref = (c: Candidate, e: Evidence): EntityRef => ({ type: f.type, id: c.id, label: c.name, detail: describeEvidence(e) });
    const [shorter, longer] = f.a.name.length <= f.b.name.length ? [f.a, f.b] : [f.b, f.a];
    const bIsAliasOfA = f.a.aliases.some((x) => normalizeName(x) === normalizeName(f.b.name));
    const why =
      f.match === 'alias'
        ? bIsAliasOfA
          ? MATCH_TEXT.alias(f.b.name, f.a.name)
          : MATCH_TEXT.alias(f.a.name, f.b.name)
        : MATCH_TEXT[f.match](shorter.name, longer.name);
    const actionId =
      existing?.actionId ??
      this.actions.propose({
        actionType: 'merge_entities',
        label: `${label} „${source.name}“ in „${target.name}“ zusammenführen`,
        rationale: why,
        confidence: MATCH_CONFIDENCE[f.match],
        affectedEntities: [ref(source, es), ref(target, et)],
        requiredConfirmation: 'confirm',
        proposedParameters: { sourceIds: [source.id], targetId: target.id, allowCrossType: false },
      }).id;

    const reason = referenceCount(et) !== referenceCount(es) ? 'mehr Verweise' : 'klarerer Name';
    const previousHint = this.insights
      .byDedupeKey(f.key)
      ?.explanation.split('\n')
      .find((l) => l.startsWith(HINT_PREFIX));
    const hintLine = hint ? `${HINT_PREFIX}${hint}` : previousHint;
    const explanation = [
      why,
      '',
      'Belege:',
      `• ${label} „${target.name}“: ${describeEvidence(et)}`,
      `• ${label} „${source.name}“: ${describeEvidence(es)}`,
      '',
      `Vorschlag: „${source.name}“ in „${target.name}“ zusammenführen (${reason}). Alle Dokumente, Entscheidungen, offenen Punkte, Ereignisse und Beziehungen werden übernommen, „${source.name}“ bleibt als anderer Name erhalten. Die Zusammenführung lässt sich rückgängig machen.`,
      '„Verschieden“ merkt sich dauerhaft, dass die beiden nicht zusammengehören.',
      ...(hintLine ? ['', hintLine] : []),
    ].join('\n');
    this.insights.upsert({
      kind: 'similar_entities',
      title:
        f.match === 'prefix'
          ? `Gehört „${longer.name}“ zu „${shorter.name}“? (${TYPE_PLURAL[f.type]})`
          : `Mögliche Dublette: ${label} „${f.a.name}“ und „${f.b.name}“`,
      explanation,
      confidence: MATCH_CONFIDENCE[f.match],
      affected: [ref(target, et), ref(source, es)],
      sourceIds: [target.id, source.id],
      recommendedActionId: actionId,
      recommendedActionLabel: `„${source.name}“ in „${target.name}“ zusammenführen`,
      dedupeKey: f.key,
    });
  }

  /**
   * Optional hint of the language model (same / different) for new pairs. Only the names are sent, and only in
   * privacy mode „auto“: in „vorher fragen“ nobody can confirm a background run, „nur lokal“ sends nothing.
   * The hint never decides anything; failures are ignored.
   */
  private async llmHints(found: Found[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    if (found.length === 0 || this.privacy.mode() !== 'auto' || !this.llm.canUse()) return out;
    const batch = found.slice(0, MAX_LLM_PAIRS);
    try {
      const res = await this.llm.completeJson(LlmHints, {
        schemaName: 'DuplicateHints',
        purpose: 'Dublettenprüfung (nur Namen)',
        instructions:
          'Du prüfst Paare von Namen aus einem persönlichen Wissensarchiv (Themen, Projekte, Tags). Gib für jedes Paar an, ob beide Namen wahrscheinlich dasselbe meinen ("same"), verschiedene Dinge ("different") oder ob das unklar ist ("unclear"), mit einer kurzen deutschen Begründung. Du entscheidest nichts, der Benutzer entscheidet.',
        input: batch.map((f, i) => `${i + 1}. ${TYPE_LABEL[f.type]}: „${f.a.name}“ / „${f.b.name}“`).join('\n'),
      });
      for (const p of res.pairs) {
        if (p.nr < 1 || p.nr > batch.length) continue;
        out.set(p.nr - 1, `${VERDICT_TEXT[p.verdict]}${p.reason?.trim() ? ` – ${truncate(p.reason.trim(), 200)}` : ''}`);
      }
    } catch (err) {
      this.ctx.logger.warn('consistency', 'LLM-Hinweis zu möglichen Dubletten nicht verfügbar', { error: err });
    }
    return out;
  }
}
