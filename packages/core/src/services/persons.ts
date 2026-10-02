import type { GraphEntity } from '@archivist/shared';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import { entities } from '../db/schema';
import {
  comparePersonNames,
  isNotAPersonName,
  isSelfReference,
  parsePersonName,
  personNameKey,
  type ParsedPersonName,
  type PersonNameRelation,
} from '../util/person-names';
import { normalizeName } from '../util/text';
import type { KnowledgeGraphService } from './knowledge-graph';

/** Where a person mention comes from; the own identity treats "ich" differently in chat and in documents. */
export type PersonMentionContext = 'chat' | 'document' | 'decision' | 'open_item' | 'manual';

/** Context of a mention made through a service call: `chat` when the chat triggered it, else the given default. */
export function mentionContext(trigger: string | undefined, fallback: PersonMentionContext): PersonMentionContext {
  return trigger === 'chat' ? 'chat' : fallback;
}

export interface SelfResolverInput {
  /** The mention as given. */
  name: string;
  parsed: ParsedPersonName;
  /** The mention is "ich", "mir", "mich", "mein …". */
  selfReference: boolean;
  context: PersonMentionContext;
}

/**
 * Maps a mention to the user's own person (own name, nicknames, "ich" in chat). Called for self references before
 * they are rejected and, as the last resolution step, for names no other step matched. Returns null when the
 * mention is not the user.
 */
export type SelfResolver = (input: SelfResolverInput) => GraphEntity | null;

export interface ResolvePersonOptions {
  /** Default `manual`. */
  context?: PersonMentionContext;
  /** `false` only looks up (no new person, no roles written). Default `true`. */
  create?: boolean;
  /** Description of a newly created person. */
  description?: string | null;
}

/** Existing person the mention might mean; the mention was NOT assigned to it (unclear, must be asked). */
export interface PersonCandidate {
  entity: GraphEntity;
  /** Why it might be meant; `shared_alias` = the mention is an alias of several persons. */
  relation: Exclude<PersonNameRelation, 'same'> | 'shared_alias';
}

export interface PersonResolution {
  /** The person, or null for non-persons and for unmatched mentions when `create` is false. */
  entity: GraphEntity | null;
  /** Name to store in name lists: the canonical person name, else the cleaned mention; null when it is not a person. */
  name: string | null;
  parsed: ParsedPersonName;
  /** Resolution step that matched: exact name, alias, name without role/title, own identity, or newly created. */
  matchedBy: 'exact' | 'alias' | 'normalized' | 'self' | 'created' | null;
  /** The mention is a pronoun/answer word ("ich", "ja", "unbekannt") or has no name in it; no person was created. */
  rejected: boolean;
  /** "ich", "mir", "mich", …: kept as text by {@link PersonService.resolveNames} outside documents. */
  selfReference: boolean;
  /** Existing persons this mention might mean (first name only, initial, similar spelling, ambiguous alias …). */
  ambiguousCandidates: PersonCandidate[];
}

export interface ResolvedNames {
  /** Canonical names in input order, without duplicates and non-persons. */
  names: string[];
  /** Resolved persons (deduplicated). */
  entities: GraphEntity[];
  resolutions: PersonResolution[];
}

type EntityRow = typeof entities.$inferSelect;

interface PersonIndexEntry {
  row: EntityRow;
  /** Normalized aliases (alias step). */
  aliases: Set<string>;
  /** Comparison key of the name. */
  nameKey: string;
  /** Comparison keys of the name and all aliases (step "name without role/title"). */
  keys: Set<string>;
  /** The stored name is already clean (no role/title in it). */
  clean: boolean;
}

const toEntity = (r: EntityRow): GraphEntity => ({
  id: r.id,
  type: 'person',
  name: r.name,
  description: r.description,
  aliases: r.aliases,
  roles: r.roles,
  duplicateOfId: r.duplicateOfId,
  isSelf: r.isSelf,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const byPreference = (a: PersonIndexEntry, b: PersonIndexEntry): number =>
  Number(b.clean) - Number(a.clean) || a.row.createdAt.localeCompare(b.row.createdAt) || a.row.id.localeCompare(b.row.id);

/**
 * Central person resolution: every place that turns a name into a person (decision participants, responsible persons,
 * document persons, chat) goes through {@link resolve}. Order: exact name → alias → name without role/title
 * (comparison key) → own identity. Roles in the mention become info on the person; pronouns and answer words never
 * become persons; unclear short forms are not assigned silently but reported as candidates.
 */
export class PersonService {
  private selfResolver: SelfResolver | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly graph: KnowledgeGraphService,
  ) {}

  private get db() {
    return this.ctx.database.db;
  }

  /** Installs (or removes) the resolver for the user's own person. */
  setSelfResolver(resolver: SelfResolver | null): void {
    this.selfResolver = resolver;
  }

  resolve(name: string, opts: ResolvePersonOptions = {}): PersonResolution {
    return this.resolveWith(name, opts, () => this.loadIndex());
  }

  /** Resolves a name list (participants, document persons) and returns the canonical names to store. */
  resolveNames(names: readonly string[], opts: ResolvePersonOptions = {}): ResolvedNames {
    let index: PersonIndexEntry[] | null = null;
    const lazyIndex = () => (index ??= this.loadIndex());
    const out: ResolvedNames = { names: [], entities: [], resolutions: [] };
    const seenNames = new Set<string>();
    const seenIds = new Set<string>();
    for (const raw of names) {
      if (!raw.trim()) continue;
      const res = this.resolveWith(raw, opts, lazyIndex);
      out.resolutions.push(res);
      if (res.matchedBy === 'created') index = null; // a new person must be found by the next mention
      if (res.entity && !seenIds.has(res.entity.id)) {
        seenIds.add(res.entity.id);
        out.entities.push(res.entity);
      }
      // "ich" stays as text outside documents (it means the user, see the own identity); in documents it is the author
      const name = res.name ?? (res.selfReference && opts.context !== 'document' ? res.parsed.raw : null);
      const key = name ? normalizeName(name) : '';
      if (!name || seenNames.has(key)) continue;
      seenNames.add(key);
      out.names.push(name);
    }
    return out;
  }

  private resolveWith(name: string, opts: ResolvePersonOptions, index: () => PersonIndexEntry[]): PersonResolution {
    const context = opts.context ?? 'manual';
    const create = opts.create !== false;
    const parsed = parsePersonName(name);
    const selfReference = isSelfReference(parsed.raw);
    const result = (entity: GraphEntity | null, matchedBy: PersonResolution['matchedBy'], ambiguousCandidates: PersonCandidate[] = []): PersonResolution => {
      if (entity && create && parsed.roles.length) entity = this.graph.addRoles(entity.id, parsed.roles);
      return { entity, name: entity?.name ?? (parsed.cleanName || null), parsed, matchedBy, rejected: false, selfReference, ambiguousCandidates };
    };

    if (isNotAPersonName(parsed.raw)) {
      const self = selfReference ? this.selfResolver?.({ name, parsed, selfReference, context }) : null;
      if (self) return result(self, 'self');
      return { entity: null, name: null, parsed, matchedBy: null, rejected: true, selfReference, ambiguousCandidates: [] };
    }

    // 1) exact name
    const exact = this.graph.findByName('person', parsed.raw);
    if (exact) return result(exact, 'exact');

    const all = index();
    // 2) alias
    const norm = normalizeName(parsed.raw);
    const aliasHits = all.filter((p) => p.aliases.has(norm));
    if (aliasHits.length === 1) return result(toEntity(aliasHits[0]!.row), 'alias');

    // 3) name without role/title (case, hyphen, umlaut spelling and "Nachname, Vorname" ignored)
    // (an alias shared by several persons is ambiguous, then only names count)
    const key = parsed.comparisonKey;
    const keyHits = key ? all.filter((p) => (aliasHits.length > 1 ? p.nameKey === key : p.keys.has(key))).sort(byPreference) : [];
    if (keyHits.length > 0) return result(toEntity(keyHits[0]!.row), 'normalized');

    // 4) own identity
    const self = this.selfResolver?.({ name, parsed, selfReference, context });
    if (self) return result(self, 'self');

    // not found: unclear candidates are reported, never assigned
    const candidates: PersonCandidate[] = aliasHits.map((p) => ({ entity: toEntity(p.row), relation: 'shared_alias' as const }));
    for (const p of all) {
      if (aliasHits.includes(p)) continue;
      const relation = comparePersonNames(parsed.cleanName, p.row.name);
      if (relation && relation !== 'same') candidates.push({ entity: toEntity(p.row), relation });
    }
    if (!create || !parsed.cleanName) return result(null, null, candidates);
    const created = this.graph.ensureEntity('person', parsed.cleanName, opts.description);
    if (candidates.length) {
      this.ctx.logger.info('persons', 'Unklare Personen-Erwähnung als eigene Person angelegt', {
        name: created.name,
        candidates: candidates.map((c) => ({ id: c.entity.id, name: c.entity.name, relation: c.relation })),
      });
    }
    return result(created, 'created', candidates);
  }

  private loadIndex(): PersonIndexEntry[] {
    return this.db
      .select()
      .from(entities)
      .where(eq(entities.type, 'person'))
      .all()
      .map((row) => {
        const parsed = parsePersonName(row.name);
        return {
          row,
          aliases: new Set(row.aliases.map(normalizeName)),
          nameKey: parsed.comparisonKey,
          keys: new Set([parsed.comparisonKey, ...row.aliases.map((a) => parsePersonName(a).comparisonKey)].filter(Boolean)),
          clean: personNameKey(row.name) === parsed.comparisonKey && parsed.titles.length === 0,
        };
      });
  }
}
