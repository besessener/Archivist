import { eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { entities, relations } from '../../db/schema';
import type { UndoService } from '../undo';
import { entityRow, relationRow, type RelationRow } from './rows';

/** Undo of a link or unlink the user made (#277). */
export const LINK_UNDO_TYPE = 'relation.link';
/** Undo of several links made at once – a bulk assignment (#286, #291). */
export const LINK_MANY_UNDO_TYPE = 'relation.linkMany';
/** Undo of several proposals decided at once (#280). */
export const DECIDE_MANY_UNDO_TYPE = 'relation.decideMany';
export const CASE_UNDO_TYPE = 'case.status';

export interface LinkUndoData {
  /** The relation as it was before (null: the call created it). */
  before: RelationRow | null;
  /** The relation as the call left it (null: the call removed it). */
  after: RelationRow | null;
}

export interface LinkManyUndoData {
  items: LinkUndoData[];
}

export interface DecideManyUndoData {
  before: Array<Pick<RelationRow, 'id' | 'status' | 'resolvedByUser' | 'updatedAt'>>;
  /** updatedAt of each relation right after the decision; a later change blocks the undo. */
  after: Record<string, string>;
}

export interface CaseUndoData {
  id: string;
  before: string | null;
  beforeUpdatedAt: string;
  afterUpdatedAt: string;
}

const changedSince = (count: number) => `${count} der Verknüpfungen wurde${count === 1 ? '' : 'n'} seither verändert oder entfernt.`;

/** Undo handlers of the user's link actions: single and bulk links, bulk decisions and case status. */
export class LinkUndo {
  constructor(private readonly ctx: AppContext) {}

  private get db() {
    return this.ctx.database.db;
  }

  register(undo: UndoService): void {
    undo.register(LINK_UNDO_TYPE, {
      check: async (data) => this.linkConflicts(data as LinkUndoData),
      run: async (data) => this.revertLink(data as LinkUndoData),
    });
    undo.register(LINK_MANY_UNDO_TYPE, {
      check: async (data) => {
        const issues = (data as LinkManyUndoData).items.flatMap((item) => this.linkConflicts(item));
        return issues.length ? [changedSince(issues.length)] : [];
      },
      run: async (data) => this.revertLinks((data as LinkManyUndoData).items),
    });
    undo.register(DECIDE_MANY_UNDO_TYPE, {
      check: async (data) => this.decisionConflicts(data as DecideManyUndoData),
      run: async (data) => this.revertDecisions(data as DecideManyUndoData),
    });
    undo.register(CASE_UNDO_TYPE, {
      check: async (data) => this.caseConflicts(data as CaseUndoData),
      run: async (data) => this.revertCaseStatus(data as CaseUndoData),
    });
  }

  private linkConflicts(data: LinkUndoData): string[] {
    const id = data.after?.id ?? data.before?.id;
    const now = id ? relationRow(this.db, id) : undefined;
    if (!data.after) return now ? ['Die Verknüpfung existiert inzwischen wieder.'] : [];
    if (!now) return ['Die Verknüpfung existiert nicht mehr.'];
    if (now.status !== data.after.status || now.updatedAt !== data.after.updatedAt) return ['Die Verknüpfung wurde seither verändert.'];
    return [];
  }

  private revertLink(data: LinkUndoData): string {
    const { before, after } = data;
    if (after && !before) this.db.delete(relations).where(eq(relations.id, after.id)).run();
    else if (before && after)
      this.db
        .update(relations)
        .set({ status: before.status, resolvedByUser: before.resolvedByUser, confidence: before.confidence, updatedAt: before.updatedAt })
        .where(eq(relations.id, before.id))
        .run();
    else if (before) this.db.insert(relations).values(before).onConflictDoNothing().run();
    this.ctx.events.changed('knowledge');
    return 'Verknüpfung zurückgesetzt.';
  }

  private revertLinks(items: LinkUndoData[]): string {
    this.ctx.database.transaction(() => {
      for (const item of items) this.revertLink(item);
    });
    return `${items.length} Zuordnung${items.length === 1 ? '' : 'en'} zurückgenommen.`;
  }

  private decisionConflicts(data: DecideManyUndoData): string[] {
    const ids = Object.keys(data.after);
    const rows = ids.length ? this.db.select().from(relations).where(inArray(relations.id, ids)).all() : [];
    const now = new Map(rows.map((row) => [row.id, row.updatedAt]));
    const changed = ids.filter((id) => now.get(id) !== data.after[id]).length;
    return changed ? [changedSince(changed)] : [];
  }

  private revertDecisions(data: DecideManyUndoData): string {
    this.ctx.database.transaction(() => {
      for (const before of data.before)
        this.db
          .update(relations)
          .set({ status: before.status, resolvedByUser: before.resolvedByUser, updatedAt: before.updatedAt })
          .where(eq(relations.id, before.id))
          .run();
    });
    this.ctx.events.changed('knowledge');
    return `${data.before.length} Entscheidung${data.before.length === 1 ? '' : 'en'} über Verknüpfungen zurückgenommen.`;
  }

  private caseConflicts(data: CaseUndoData): string[] {
    const row = entityRow(this.db, data.id);
    if (!row) return ['Der Vorgang existiert nicht mehr.'];
    return row.updatedAt !== data.afterUpdatedAt ? ['Der Vorgang wurde seither verändert.'] : [];
  }

  private revertCaseStatus(data: CaseUndoData): string {
    this.db.update(entities).set({ status: data.before, updatedAt: data.beforeUpdatedAt }).where(eq(entities.id, data.id)).run();
    this.ctx.events.changed('knowledge');
    return 'Status des Vorgangs zurückgesetzt.';
  }
}
