import type { EntityRef, TimelineEntry } from '@archivist/shared';
import type { AppContext } from '../context';
import { contradictions, decisions, documents, openItems } from '../db/schema';
import { truncate } from '../util/text';
import type { KnowledgeGraphService } from './knowledge-graph';

export interface TimelineQuery {
  topicId?: string;
  projectId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

/** Chronologische Sicht auf Dokumente, Entscheidungen, offene Punkte und Widersprüche – jeder Eintrag verweist auf seine Objekte. */
export class TimelineService {
  constructor(
    private readonly ctx: AppContext,
    private readonly graph: KnowledgeGraphService,
  ) {}

  get(q: TimelineQuery = {}): TimelineEntry[] {
    const db = this.ctx.database.db;
    const out: TimelineEntry[] = [];
    const match = (topicId: string | null, projectId: string | null) => {
      if (q.topicId && topicId !== q.topicId) return false;
      if (q.projectId && projectId !== q.projectId) return false;
      return true;
    };
    const ref = (type: EntityRef['type'], id: string | null, label?: string | null): EntityRef[] => (id ? [{ type, id, label: label ?? this.graph.getEntity(id)?.name ?? id }] : []);
    const push = (e: Omit<TimelineEntry, 'year'>) => {
      const date = e.date.slice(0, 10);
      if (q.from && date < q.from.slice(0, 10)) return;
      if (q.to && date > q.to.slice(0, 10)) return;
      out.push({ ...e, date, year: Number(date.slice(0, 4)) || 0 });
    };

    for (const d of db.select().from(documents).all()) {
      if (!['archived', 'indexed_only'].includes(d.status) || !match(d.topicId, d.projectId)) continue;
      push({
        id: `doc:${d.id}`,
        date: d.dates[0] ?? d.archivedAt ?? d.createdAt,
        kind: 'document',
        title: `Dokument: ${d.title}`,
        description: d.summary ? truncate(d.summary, 220) : null,
        refs: [{ type: 'document', id: d.id, label: d.title }, ...ref('topic', d.topicId), ...ref('project', d.projectId)],
      });
    }
    for (const d of db.select().from(decisions).all()) {
      if (!match(d.topicId, d.projectId)) continue;
      push({
        id: `dec:${d.id}`,
        date: d.decidedAt ?? d.createdAt,
        kind: 'decision',
        title: `Entscheidung${d.status === 'superseded' ? ' (überholt)' : d.status === 'draft' ? ' (Entwurf)' : ''}: ${d.title}`,
        description: truncate(d.decisionText, 240),
        refs: [{ type: 'decision', id: d.id, label: d.title }, ...ref('topic', d.topicId), ...ref('project', d.projectId)],
      });
    }
    for (const o of db.select().from(openItems).all()) {
      if (!match(o.topicId, o.projectId)) continue;
      const refs: EntityRef[] = [{ type: 'task', id: o.id, label: o.title }, ...ref('topic', o.topicId), ...ref('project', o.projectId)];
      push({ id: `task:${o.id}:created`, date: o.createdAt, kind: 'open_item', title: `Offener Punkt angelegt: ${o.title}`, description: o.description ? truncate(o.description, 200) : null, refs });
      if (o.dueAt) push({ id: `task:${o.id}:due`, date: o.dueAt, kind: 'open_item', title: `Fällig: ${o.title}`, description: `Status: ${o.status}`, refs });
      if (o.status === 'resolved' || o.status === 'dismissed') push({ id: `task:${o.id}:done`, date: o.updatedAt, kind: 'open_item', title: `${o.status === 'resolved' ? 'Erledigt' : 'Verworfen'}: ${o.title}`, description: null, refs });
    }
    if (!q.topicId && !q.projectId) {
      for (const c of db.select().from(contradictions).all()) {
        push({ id: `contra:${c.id}`, date: c.createdAt, kind: 'contradiction', title: c.title, description: truncate(c.description, 240), refs: c.affectedEntityIds.map((id) => ({ type: 'decision' as const, id, label: this.graph.getEntity(id)?.name ?? id })) });
      }
    } else {
      // Widersprüche, die Entscheidungen dieses Themas/Projekts betreffen
      const decIds = new Set(db.select().from(decisions).all().filter((d) => match(d.topicId, d.projectId)).map((d) => d.id));
      for (const c of db.select().from(contradictions).all()) {
        if (c.affectedEntityIds.some((id) => decIds.has(id))) {
          push({ id: `contra:${c.id}`, date: c.createdAt, kind: 'contradiction', title: c.title, description: truncate(c.description, 240), refs: c.affectedEntityIds.map((id) => ({ type: 'decision' as const, id, label: this.graph.getEntity(id)?.name ?? id })) });
        }
      }
    }
    return out.toSorted((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)).slice(0, q.limit ?? 300);
  }
}
