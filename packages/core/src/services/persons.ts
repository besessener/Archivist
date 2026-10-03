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

/** Maps a mention to the user's own person (own name, nicknames, "ich" in chat), or null when it is not the user. */
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

/** All indexed persons and those whose alias is the mention. */
interface IndexHits {
  all: PersonIndexEntry[];
  aliasHits: PersonIndexEntry[];
}

const byPreference = (a: PersonIndexEntry, b: PersonIndexEntry): number =>
  Number(b.clean) - Number(a.clean) || a.row.createdAt.localeCompare(b.row.createdAt) || a.row.id.localeCompare(b.row.id);

/** Step "name without role/title"; an alias shared by several persons is ambiguous, then only names count. */
function keyMatch(parsed: ParsedPersonName, { all, aliasHits }: IndexHits): PersonIndexEntry | undefined {
  const key = parsed.comparisonKey;
  if (!key) return undefined;
  return all.filter((p) => (aliasHits.length > 1 ? p.nameKey === key : p.keys.has(key))).sort(byPreference)[0];
}

/** Persons the mention might mean but was not assigned to: a shared alias, or a similar name. */
function unclearCandidates(parsed: ParsedPersonName, { all, aliasHits }: IndexHits): PersonCandidate[] {
  const candidates: PersonCandidate[] = aliasHits.map((p) => ({ entity: toEntity(p.row), relation: 'shared_alias' as const }));
  for (const p of all) {
    if (aliasHits.includes(p)) continue;
    const relation = comparePersonNames(parsed.cleanName, p.row.name);
    if (relation && relation !== 'same') candidates.push({ entity: toEntity(p.row), relation });
  }
  return candidates;
}

/** "ich" stays as text outside documents (it means the user, see the own identity); in documents it is the author. */
function storedName(resolution: PersonResolution, context: PersonMentionContext | undefined): string | null {
  return resolution.name ?? (resolution.selfReference && context !== 'document' ? resolution.parsed.raw : null);
}

const NO_SELF: SelfResolver = () => null;

/** Turns names into persons: exact name → alias → name without role/title → own identity; unclear ones are reported, not assigned. */
export class PersonService {
  private selfResolver: SelfResolver = NO_SELF;

  constructor(
    private readonly ctx: AppContext,
    private readonly graph: KnowledgeGraphService,
  ) {}

  private get db() {
    return this.ctx.database.db;
  }

  /** Installs (or, with null, removes) the resolver for the user's own person. */
  setSelfResolver(resolver: SelfResolver | null): void {
    this.selfResolver = resolver ?? NO_SELF;
  }

  resolve(name: string, opts: ResolvePersonOptions = {}): PersonResolution {
    return this.resolveWith(name, { ...opts, index: () => this.loadIndex() });
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
      const resolution = this.resolveWith(raw, { ...opts, index: lazyIndex });
      out.resolutions.push(resolution);
      if (resolution.matchedBy === 'created') index = null; // a new person must be found by the next mention
      if (resolution.entity && !seenIds.has(resolution.entity.id)) {
        seenIds.add(resolution.entity.id);
        out.entities.push(resolution.entity);
      }
      const name = storedName(resolution, opts.context);
      const key = name ? normalizeName(name) : '';
      if (!name || seenNames.has(key)) continue;
      seenNames.add(key);
      out.names.push(name);
    }
    return out;
  }

  private resolveWith(name: string, opts: ResolvePersonOptions & { index: () => PersonIndexEntry[] }): PersonResolution {
    const parsed = parsePersonName(name);
    const mention: SelfResolverInput = { name, parsed, selfReference: isSelfReference(parsed.raw), context: opts.context ?? 'manual' };
    const create = opts.create !== false;
    const result = (entity: GraphEntity | null, match: { matchedBy: PersonResolution['matchedBy']; candidates?: PersonCandidate[] }): PersonResolution => {
      const withRoles = entity && create && parsed.roles.length ? this.graph.addRoles(entity.id, parsed.roles) : entity;
      const resolvedName = withRoles?.name ?? (parsed.cleanName || null);
      return {
        entity: withRoles,
        name: resolvedName,
        parsed,
        matchedBy: match.matchedBy,
        rejected: false,
        selfReference: mention.selfReference,
        ambiguousCandidates: match.candidates ?? [],
      };
    };

    if (isNotAPersonName(parsed.raw)) {
      const self = mention.selfReference ? this.selfResolver(mention) : null;
      if (self) return result(self, { matchedBy: 'self' });
      return { entity: null, name: null, parsed, matchedBy: null, rejected: true, selfReference: mention.selfReference, ambiguousCandidates: [] };
    }
    const exact = this.graph.findByName('person', parsed.raw);
    if (exact) return result(exact, { matchedBy: 'exact' });
    const all = opts.index();
    const normalized = normalizeName(parsed.raw);
    const aliasHits = all.filter((p) => p.aliases.has(normalized));
    if (aliasHits.length === 1) return result(toEntity(aliasHits[0]!.row), { matchedBy: 'alias' });
    const byKey = keyMatch(parsed, { all, aliasHits });
    if (byKey) return result(toEntity(byKey.row), { matchedBy: 'normalized' });
    const self = this.selfResolver(mention);
    if (self) return result(self, { matchedBy: 'self' });
    const candidates = unclearCandidates(parsed, { all, aliasHits });
    if (!create || !parsed.cleanName) return result(null, { matchedBy: null, candidates });
    return result(this.createPerson(parsed.cleanName, { description: opts.description, candidates }), { matchedBy: 'created', candidates });
  }

  /** A mention no step matched becomes a new person; unclear candidates are only logged, never assigned. */
  private createPerson(name: string, opts: { description?: string | null; candidates: PersonCandidate[] }): GraphEntity {
    const created = this.graph.ensureEntity({ type: 'person', name, description: opts.description });
    if (opts.candidates.length) {
      this.ctx.logger.info('persons', 'Unclear person mention created as a separate person', {
        name: created.name,
        candidates: opts.candidates.map((c) => ({ id: c.entity.id, name: c.entity.name, relation: c.relation })),
      });
    }
    return created;
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
