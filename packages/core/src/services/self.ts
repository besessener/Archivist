import type { GraphEntity } from '@archivist/shared';
import { and, eq, ne } from 'drizzle-orm';
import type { AppContext } from '../context';
import { entities } from '../db/schema';
import { parsePersonName } from '../util/person-names';
import type { KnowledgeGraphService } from './knowledge-graph';
import type { SelfResolver } from './persons';
import type { SettingsService } from './settings';

/** Name of the own person while no name is entered in the profile. */
export const SELF_PLACEHOLDER = 'Ich';
/** Audit action when an existing person with the user's name is merged into the own person. */
export const SELF_MERGE_ACTION = 'persons.self_merge';

export type SelfServiceDeps = { ctx: AppContext; settings: SettingsService; graph: KnowledgeGraphService };

/** The user's own person (`isSelf`, badge „Du“): named like the profile, else „Ich“ until a name is entered. */
export class SelfService {
  private readonly ctx: AppContext;
  private readonly settings: SettingsService;
  private readonly graph: KnowledgeGraphService;

  constructor(deps: SelfServiceDeps) {
    ({ ctx: this.ctx, settings: this.settings, graph: this.graph } = deps);
  }

  private get db() {
    return this.ctx.database.db;
  }

  /** The own person, if it exists yet. */
  get(): GraphEntity | undefined {
    const row = this.db
      .select({ id: entities.id })
      .from(entities)
      .where(and(eq(entities.type, 'person'), eq(entities.isSelf, true)))
      .get();
    return row ? this.graph.getEntity(row.id) : undefined;
  }

  /** Comparison keys of the profile name and the nicknames. */
  ownNameKeys(): Set<string> {
    const profile = this.settings.get().profile;
    return new Set([profile.name, ...profile.nicknames].map((n) => parsePersonName(n).comparisonKey).filter(Boolean));
  }

  isOwnName(name: string): boolean {
    const key = parsePersonName(name).comparisonKey;
    return Boolean(key) && this.ownNameKeys().has(key);
  }

  /** The own person, created on first use: an existing person with the profile name becomes it, else a new one. */
  ensure(): GraphEntity {
    const existing = this.get();
    if (existing) return existing;
    const name = this.settings.get().profile.name.trim();
    const candidate = name ? this.personWithKey(parsePersonName(name).comparisonKey) : undefined;
    const entity = candidate ?? this.graph.ensureEntity({ type: 'person', name: name || SELF_PLACEHOLDER });
    this.db.update(entities).set({ isSelf: true }).where(eq(entities.id, entity.id)).run();
    this.ctx.events.changed('knowledge');
    return this.graph.getEntity(entity.id)!;
  }

  /** Self resolver of the person service: chat self references and the own name/nicknames mean the user. */
  readonly resolver: SelfResolver = (input) => {
    if (input.selfReference) return input.context === 'chat' ? this.ensure() : null; // in documents „ich“ is the author
    return input.parsed.comparisonKey && this.ownNameKeys().has(input.parsed.comparisonKey) ? this.ensure() : null;
  };

  /** Applies the profile name: renames the own person, or merges a person already carrying it into it (undoable). */
  async syncProfile(): Promise<void> {
    const self = this.get();
    const name = this.settings.get().profile.name.trim();
    if (!self || !name || self.name === name) return;
    const key = parsePersonName(name).comparisonKey;
    const other = key ? this.personWithKey(key, self.id) : undefined;
    if (other) {
      await this.graph.merge({ sourceIds: [other.id], targetId: self.id, targetName: name }, { actor: 'user', trigger: 'profile', action: SELF_MERGE_ACTION });
    } else {
      await this.graph.rename({ id: self.id, name }, { actor: 'user', trigger: 'profile', keepOldName: self.name !== SELF_PLACEHOLDER });
    }
    this.ctx.logger.info('persons', 'Own person adjusted to the profile name', { from: self.name, to: name, merged: Boolean(other) });
  }

  private personWithKey(key: string, exceptId?: string): GraphEntity | undefined {
    const rows = this.db
      .select({ id: entities.id, name: entities.name })
      .from(entities)
      .where(exceptId ? and(eq(entities.type, 'person'), ne(entities.id, exceptId)) : eq(entities.type, 'person'))
      .all();
    const hit = rows.find((r) => parsePersonName(r.name).comparisonKey === key);
    return hit ? this.graph.getEntity(hit.id) : undefined;
  }
}
