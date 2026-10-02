import { eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import { decisions, entities, events, openItems, relations, reminders } from '../db/schema';
import type { KnowledgeGraphService } from '../services/knowledge-graph';
import type { SearchService } from '../services/search';
import type { UndoService } from '../services/undo';

/** Undo type that services get automatically for `*.create` entries written inside an agent run (#299). */
export const CREATED_UNDO_TYPE = 'agent_created';

export interface CreatedUndoData {
  action: string;
  id: string;
}

type Kind = 'decision' | 'open_item' | 'event' | 'reminder' | 'entity';

function kindOf(action: string): Kind | null {
  const head = action.split('.')[0];
  if (head === 'decision' || head === 'open_item' || head === 'event' || head === 'reminder') return head;
  if (head === 'note' || head === 'entity' || head === 'case') return 'entity';
  return null;
}

/**
 * Takes back entries the agent created (decisions, open items, events, reminders, notes, topics, cases): only while they
 * were not changed since – a later edit by the user is never thrown away unnoticed.
 */
export function registerCreatedUndo(ctx: AppContext, undo: UndoService, graph: KnowledgeGraphService, search: SearchService): void {
  const db = () => ctx.database.db;
  const row = (kind: Kind, id: string): { createdAt: string; updatedAt: string; status?: string | null } | undefined => {
    switch (kind) {
      case 'decision':
        return db().select().from(decisions).where(eq(decisions.id, id)).get();
      case 'open_item':
        return db().select().from(openItems).where(eq(openItems.id, id)).get();
      case 'event':
        return db().select().from(events).where(eq(events.id, id)).get();
      case 'reminder': {
        const r = db().select().from(reminders).where(eq(reminders.id, id)).get();
        return r ? { createdAt: r.createdAt, updatedAt: r.createdAt, status: r.status } : undefined;
      }
      case 'entity':
        return db().select().from(entities).where(eq(entities.id, id)).get();
    }
  };
  undo.register(CREATED_UNDO_TYPE, {
    check: async (data) => {
      const d = data as CreatedUndoData;
      const kind = kindOf(d.action);
      if (!kind) return ['Diese Art Eintrag kann nicht zurückgenommen werden.'];
      const r = row(kind, d.id);
      if (!r) return ['Der Eintrag existiert nicht mehr.'];
      if (kind === 'reminder') return r.status === 'pending' ? [] : ['Die Erinnerung wurde inzwischen ausgelöst oder verworfen.'];
      if (r.updatedAt !== r.createdAt && kind !== 'entity') return ['Der Eintrag wurde seit dem Anlegen bearbeitet.'];
      return [];
    },
    run: async (data) => {
      const d = data as CreatedUndoData;
      const kind = kindOf(d.action)!;
      ctx.database.transaction(() => {
        if (kind === 'decision') db().delete(decisions).where(eq(decisions.id, d.id)).run();
        if (kind === 'open_item') db().delete(openItems).where(eq(openItems.id, d.id)).run();
        if (kind === 'event') db().delete(events).where(eq(events.id, d.id)).run();
        if (kind === 'reminder') db().update(reminders).set({ status: 'dismissed' }).where(eq(reminders.id, d.id)).run();
        if (kind !== 'reminder') {
          db().delete(relations).where(eq(relations.sourceEntityId, d.id)).run();
          db().delete(relations).where(eq(relations.targetEntityId, d.id)).run();
          graph.removeNode(d.id);
        }
      });
      if (kind !== 'reminder') search.remove(d.id);
      ctx.events.changed('decisions', 'openItems', 'events', 'reminders', 'knowledge');
      return 'Eintrag zurückgenommen.';
    },
  });
}
